/**
 * COMMUNITY / store — the four fields we are allowed to remember about a person.
 *
 * One small JSON file under dataDir (`insiders.json`) holding one row per member
 * who earned the `Insider` role. THE STORED SHAPE, in full:
 *
 *   {
 *     "insiders": [
 *       {
 *         "discord_id":   "1234567890",                 // who the role belongs to
 *         "github_login": "octocat",                    // the account that earned it
 *         "granted_at":   "2026-08-08T12:00:00.000Z",   // when we granted it
 *         "basis":        "pr" | "issue" | "finding"    // what earned it
 *       }
 *     ]
 *   }
 *
 * That is the whole record. There is no engagement history, no activity log, no
 * email, no star count and no star flag of any kind, no record of anybody else's
 * actions, and no evidence copy: the contribution that earned the role is public
 * on GitHub and re-checkable by anyone, so keeping our own copy would only build
 * a private dossier we would then have to protect. Four fields is not an
 * accident of implementation — it is the feature's contract with the people in
 * it, and {@link INSIDER_FIELDS} exists so a test can hold us to it.
 *
 * Adding a field here needs the same justification: what breaks without it, and
 * what happens to the person if it leaks.
 *
 * WHY WE STORE ANYTHING AT ALL. Discord roles are the projection, not the
 * record: a member who loses the role in a server rebuild must be able to get it
 * back without re-proving anything, and a person who asks to be forgotten must
 * leave behind nothing at all — which is only possible if there is exactly one
 * place to delete from. See {@link InsiderStore.forget}.
 *
 * Behaviour, matching every other state file in this codebase:
 *  - Missing file → empty roster. Unparseable file → warn + empty roster; the
 *    bot must come up over a damaged local file.
 *  - A single malformed ROW is dropped, not the whole roster (one bad line must
 *    not silently revoke everyone's access).
 *  - Unknown keys are STRIPPED on load (zod object parsing), so a hand-edited
 *    file that adds `email` or an activity trail cannot smuggle it back in.
 *  - Every write is atomic (tmp + rename).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJsonAsync } from "../theoxenia/state.js";
import type { Logger } from "../types.js";

const STORE_FILE = "insiders.json";

/**
 * What earned the role. Deliberately a closed set of three CONTRIBUTIONS:
 *  - `pr`      — a merged pull request in the org,
 *  - `issue`   — an opened issue that a maintainer answered,
 *  - `finding` — a MOMUS finding an operator marked confirmed.
 * There is no basis for endorsing, following or starring the project, and there
 * is deliberately nowhere to record one.
 */
export const INSIDER_BASES = ["pr", "issue", "finding"] as const;
export type InsiderBasis = (typeof INSIDER_BASES)[number];

/**
 * The ONLY keys ever persisted about a person, enumerated so the data-minimisation
 * promise is testable rather than aspirational.
 */
export const INSIDER_FIELDS = ["discord_id", "github_login", "granted_at", "basis"] as const;

const RecordSchema = z.object({
  discord_id: z.string().min(1),
  /** GitHub login as GITHUB reported it (canonical case), "" for an operator grant. */
  github_login: z.string(),
  granted_at: z.string(),
  basis: z.enum(INSIDER_BASES),
});

export type InsiderRecord = z.infer<typeof RecordSchema>;

/** Rows are parsed one at a time, so one broken row cannot revoke the roster. */
const FileSchema = z.object({
  insiders: z.array(z.unknown()).catch([]),
});

function lower(s: string): string {
  return s.trim().toLowerCase();
}

export class InsiderStore {
  private readonly file: string;
  private rows: InsiderRecord[];

  constructor(
    dataDir: string,
    private readonly log: Logger,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, STORE_FILE);
    this.rows = this.load();
  }

  private load(): InsiderRecord[] {
    if (!existsSync(this.file)) return [];
    let parsedFile: z.infer<typeof FileSchema>;
    try {
      parsedFile = FileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (err) {
      // An empty roster means members re-prove a contribution — annoying but
      // honest. Refusing to boot would take the whole bot down over one file.
      this.log.warn("insider roster unreadable — starting empty (members can re-prove)", {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const rows: InsiderRecord[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const raw of parsedFile.insiders) {
      const row = RecordSchema.safeParse(raw);
      if (!row.success) {
        dropped++;
        continue;
      }
      // One discord id holds the role once; a duplicated row is a file edit, and
      // keeping the first occurrence keeps every lookup deterministic.
      if (seen.has(row.data.discord_id)) {
        dropped++;
        continue;
      }
      seen.add(row.data.discord_id);
      rows.push(row.data);
    }
    if (dropped > 0) {
      this.log.warn("insider rows dropped for failing shape validation", { dropped });
    }
    return rows;
  }

  private async save(): Promise<void> {
    // Written field-by-field rather than by spreading the in-memory row: the file
    // on disk can then only ever contain the four allowed keys, whatever a future
    // edit adds to the type.
    await atomicWriteJsonAsync(this.file, {
      insiders: this.rows.map((r) => ({
        discord_id: r.discord_id,
        github_login: r.github_login,
        granted_at: r.granted_at,
        basis: r.basis,
      })),
    });
  }

  /** Path of the roster file — handy for operators and tests, never logged with contents. */
  get path(): string {
    return this.file;
  }

  get size(): number {
    return this.rows.length;
  }

  get(discordId: string): InsiderRecord | undefined {
    return this.rows.find((r) => r.discord_id === discordId);
  }

  has(discordId: string): boolean {
    return this.get(discordId) !== undefined;
  }

  /** Copies, so no caller can mutate the roster behind the store's back. */
  list(): InsiderRecord[] {
    return this.rows.map((r) => ({ ...r }));
  }

  /**
   * One GitHub account earns the role for ONE person. Without this a single
   * merged pull request could be replayed by everybody who can read it.
   */
  findByLogin(githubLogin: string): InsiderRecord | undefined {
    if (lower(githubLogin) === "") return undefined;
    return this.rows.find((r) => lower(r.github_login) === lower(githubLogin));
  }

  /** Insert or replace one row and persist. Throws only if the disk write fails. */
  async grant(record: InsiderRecord): Promise<void> {
    const row: InsiderRecord = {
      discord_id: record.discord_id,
      github_login: record.github_login,
      granted_at: record.granted_at,
      basis: record.basis,
    };
    const idx = this.rows.findIndex((r) => r.discord_id === row.discord_id);
    if (idx >= 0) this.rows[idx] = row;
    else this.rows.push(row);
    await this.save();
  }

  /**
   * Forget a person: the row is DELETED, not flagged. A "revoked" marker would
   * mean the roster still remembers that this discord id was once an insider,
   * which is the opposite of what somebody asking to be forgotten asked for.
   *
   * Returns true when a row was actually removed.
   */
  async forget(discordId: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.discord_id !== discordId);
    if (this.rows.length === before) return false;
    await this.save();
    return true;
  }
}
