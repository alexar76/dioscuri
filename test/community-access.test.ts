/**
 * INSIDERS GATE tests — the negative ones are the point.
 *
 * What must hold, and why each case exists:
 *
 *  - the public challenge PROVES control of a GitHub account, and a code minted
 *    for a different Discord member is refused (otherwise the gate is "paste
 *    somebody else's code");
 *  - an expired code is refused (a bearer proof with no TTL is a permanent one);
 *  - an empty issue with no maintainer response earns NOTHING — that clause is
 *    the whole anti-farming design, and a self-answered issue must not pass it;
 *  - a merged pull request does earn it;
 *  - NO STAR ENDPOINT IS EVER CALLED. Asserted twice: by scanning the module
 *    source (dist is compiled from these bytes) for the star route/field names,
 *    and by a fake GitHub client that records every property the gate reaches for.
 *    A gate that "just peeks" at who endorsed the project is the thing being
 *    ruled out — not for access, not for a badge, not once;
 *  - the provision plan creates exactly ONE new role, `Insider`, and no cosmetic
 *    second tier;
 *  - the roster on disk holds exactly four fields per person and nothing else;
 *  - a person can ask to be forgotten and their row is DELETED, not flagged.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InsiderGate, InsiderStore, INSIDER_FIELDS } from "../src/community/index.js";
import type {
  GistSummary,
  GithubPublicReader,
  IssueComment,
  IssueRef,
} from "../src/community/github.js";
import {
  DESIRED_STRUCTURE,
  INSIDER_ROLE,
  MOMUS_BULLETIN_CHANNEL,
  MOMUS_INSIDERS_CHANNEL,
  planProvision,
} from "../src/provision/structure.js";
import type { AuditChainEntry, AuditEvent, AuditLog, Logger } from "../src/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};

const OWNER = "alexar76";
const PROOF_ISSUE = { repo: "aicom", number: 42 };
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const TTL_MS = 30 * 60 * 1000;

/** Everything the fake GitHub knows, keyed the way the gate asks for it. */
interface GithubFixture {
  gists: Record<string, GistSummary[]>;
  /** `${repo}#${number}` → comments. */
  comments: Record<string, IssueComment[]>;
  mergedPrs: Record<string, IssueRef[]>;
  authoredIssues: Record<string, IssueRef[]>;
}

function emptyFixture(): GithubFixture {
  return { gists: {}, comments: {}, mergedPrs: {}, authoredIssues: {} };
}

function gist(description: string, ownerLogin = "octocat", filenames: string[] = ["proof.txt"]): GistSummary {
  return { id: "g1", description, filenames, isPublic: true, ownerLogin };
}

/**
 * A fake GitHub client that records BOTH the routes it served and every property
 * the gate reached for. The Proxy is the interesting half: an unimplemented
 * method (a star-list read, say) shows up in `touched` instead of quietly
 * returning undefined, so "no star route was called" is an assertion about
 * behaviour rather than about the interface's shape.
 */
function makeGithub(fixture: GithubFixture): {
  github: GithubPublicReader;
  calls: string[];
  touched: string[];
} {
  const calls: string[] = [];
  const touched: string[] = [];
  /** GitHub matches logins case-insensitively; the fake must too. */
  const byLogin = <T>(table: Record<string, T[]>, login: string): T[] => {
    const hit = Object.entries(table).find(([k]) => k.toLowerCase() === login.toLowerCase());
    return hit?.[1] ?? [];
  };
  const impl: GithubPublicReader = {
    async listPublicGists(login) {
      calls.push(`GET /users/${login}/gists`);
      return byLogin(fixture.gists, login);
    },
    async listIssueComments({ repo, issueNumber }) {
      calls.push(`GET /repos/${OWNER}/${repo}/issues/${issueNumber}/comments`);
      return fixture.comments[`${repo}#${issueNumber}`] ?? [];
    },
    async searchMergedPullRequests({ login }) {
      calls.push(`GET /search/issues?q=is:pr+is:merged+author:${login}+user:${OWNER}`);
      return byLogin(fixture.mergedPrs, login);
    },
    async searchAuthoredIssues({ login }) {
      calls.push(`GET /search/issues?q=is:issue+author:${login}+user:${OWNER}`);
      return byLogin(fixture.authoredIssues, login);
    },
  };
  const github = new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop === "string") touched.push(prop);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as GithubPublicReader;
  return { github, calls, touched };
}

class MemoryAudit implements AuditLog {
  readonly entries: AuditEvent[] = [];
  async append(ev: AuditEvent): Promise<AuditChainEntry> {
    this.entries.push(ev);
    return { ...ev, hash: "h", prevHash: "p" };
  }
  async verify(): Promise<number> {
    return -1;
  }
}

let dir: string;
let clock: number;
let store: InsiderStore;
let audit: MemoryAudit;

function buildGate(
  fixture: GithubFixture,
  opts: { allowGistProof?: boolean; withProofIssue?: boolean } = {},
): { gate: InsiderGate; calls: string[]; touched: string[] } {
  const { github, calls, touched } = makeGithub(fixture);
  const gate = new InsiderGate({
    owner: OWNER,
    store,
    github,
    log: nullLogger,
    audit,
    ...(opts.withProofIssue === false ? {} : { proofIssue: PROOF_ISSUE }),
    allowGistProof: opts.allowGistProof !== false,
    codeTtlMs: TTL_MS,
    now: () => clock,
  });
  return { gate, calls, touched };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dioscuri-insiders-"));
  clock = NOW;
  store = new InsiderStore(dir, nullLogger);
  audit = new MemoryAudit();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The roster as it actually sits on disk. */
function rosterOnDisk(): { insiders: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, "insiders.json"), "utf8")) as {
    insiders: Array<Record<string, unknown>>;
  };
}

// ---------------------------------------------------------------------------
// The challenge proves the account
// ---------------------------------------------------------------------------

describe("challenge", () => {
  it("proves account control through a public gist, and a merged PR earns Insider", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 5, url: "https://example.test/pr/5" }];
    const { gate, calls } = buildGate(fixture);

    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.code).toMatch(/^DIOSCURI-[0-9A-F]{16}$/);
    // Minting a code must cost no API call: a typo should not hit GitHub.
    expect(calls).toEqual([]);

    // The member publishes the code under their own account.
    fixture.gists.octocat = [gist(`AICOM insider verification ${issued.code}`)];

    const granted = await gate.redeem({ discordId: "d1" });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.basis).toBe("pr");
    expect(granted.roleName).toBe(INSIDER_ROLE);
    expect(granted.record.github_login).toBe("octocat");
    expect(store.has("d1")).toBe(true);

    // One grant, one audit line, on the stated basis.
    expect(audit.entries.map((e) => e.kind)).toEqual(["insiders.grant"]);
    expect(audit.entries[0]?.data).toEqual({ basis: "pr", github_login: "octocat" });
  });

  it("accepts a comment on the designated public issue as proof", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 5, url: "" }];
    const { gate } = buildGate(fixture, { allowGistProof: false });

    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.comments[`${PROOF_ISSUE.repo}#${PROOF_ISSUE.number}`] = [
      { authorLogin: "Octocat", authorAssociation: "NONE", body: `verifying: ${issued.code}` },
    ];

    const granted = await gate.redeem({ discordId: "d1" });
    expect(granted.ok).toBe(true);
    // Stored as GitHub spells it, not as the member typed it.
    if (granted.ok) expect(granted.record.github_login).toBe("Octocat");
  });

  it("refuses a code that was minted for a DIFFERENT discord id", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.eve = [{ repo: "aicom", number: 9, url: "" }];
    const { gate } = buildGate(fixture);

    const forD1 = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!forD1.ok) throw new Error("challenge not issued");
    // Eve starts her own verification but publishes d1's code instead of her own.
    const forEve = gate.startChallenge({ discordId: "d2", githubLogin: "eve" });
    expect(forEve.ok).toBe(true);
    fixture.gists.eve = [gist(`me too ${forD1.code}`, "eve")];

    const refused = await gate.redeem({ discordId: "d2" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("CODE_NOT_YOURS");
    expect(store.has("d2")).toBe(false);
    // Even though Eve has a merged PR, no grant happened: the account was not proved.
    expect(audit.entries).toEqual([]);
  });

  it("refuses our own code when a different account published it", async () => {
    const fixture = emptyFixture();
    const { gate } = buildGate(fixture, { allowGistProof: false });
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.comments[`${PROOF_ISSUE.repo}#${PROOF_ISSUE.number}`] = [
      { authorLogin: "impostor", authorAssociation: "NONE", body: issued.code },
    ];

    const refused = await gate.redeem({ discordId: "d1" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("PROOF_AUTHOR_MISMATCH");
    // The impostor's login is never echoed back to the member.
    if (!refused.ok) expect(refused.message).not.toContain("impostor");
  });

  it("spaces out redemption attempts instead of hammering GitHub", async () => {
    const fixture = emptyFixture();
    const { gate, calls } = buildGate(fixture); // no gist, no comment: nothing to find
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");

    const first = await gate.redeem({ discordId: "d1" });
    if (!first.ok) expect(first.code).toBe("PROOF_NOT_FOUND");
    const callsAfterFirst = calls.length;

    const immediate = await gate.redeem({ discordId: "d1" });
    expect(immediate.ok).toBe(false);
    if (!immediate.ok) expect(immediate.code).toBe("TOO_SOON");
    // The refusal happened before any request — that is the resource being saved.
    expect(calls.length).toBe(callsAfterFirst);

    clock = NOW + 21_000;
    fixture.gists.octocat = [gist(issued.code)];
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 5, url: "" }];
    expect((await gate.redeem({ discordId: "d1" })).ok).toBe(true);
  });

  it("refuses a gist owned by an account other than the one claimed", async () => {
    const fixture = emptyFixture();
    const { gate } = buildGate(fixture);
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    // Same code, but the listing came back owned by somebody else (rename/redirect).
    fixture.gists.octocat = [gist(issued.code, "someone-else")];

    const refused = await gate.redeem({ discordId: "d1" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("PROOF_AUTHOR_MISMATCH");
  });

  it("refuses an expired code", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 5, url: "" }];
    const { gate } = buildGate(fixture);

    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.gists.octocat = [gist(issued.code)];

    clock = NOW + TTL_MS + 1;
    const refused = await gate.redeem({ discordId: "d1" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("EXPIRED");
    expect(store.has("d1")).toBe(false);
    // The expired code is dropped, so a second attempt is not "expired" forever.
    const again = await gate.redeem({ discordId: "d1" });
    if (!again.ok) expect(again.code).toBe("NO_CHALLENGE");
  });

  it("refuses to reuse one GitHub account for a second discord id", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 5, url: "" }];
    const { gate } = buildGate(fixture);
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.gists.octocat = [gist(issued.code)];
    expect((await gate.redeem({ discordId: "d1" })).ok).toBe(true);

    const second = gate.startChallenge({ discordId: "d2", githubLogin: "octocat" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("LOGIN_ALREADY_CLAIMED");
  });
});

// ---------------------------------------------------------------------------
// Contribution — the anti-farming clause
// ---------------------------------------------------------------------------

describe("contribution", () => {
  /** Prove the account, then let the caller assert on what the gate decided. */
  async function proveAndRedeem(fixture: GithubFixture, login = "octocat") {
    const { gate, calls } = buildGate(fixture);
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: login });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.gists[login] = [gist(issued.code)];
    return { result: await gate.redeem({ discordId: "d1" }), calls };
  }

  it("does NOT earn Insider for an empty issue with no maintainer response", async () => {
    const fixture = emptyFixture();
    fixture.authoredIssues.octocat = [{ repo: "aicom", number: 7, url: "" }];
    fixture.comments["aicom#7"] = []; // opened, nobody answered

    const { result } = await proveAndRedeem(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_CONTRIBUTION");
    expect(store.size).toBe(0);
  });

  it("does NOT count the issue author answering themselves", async () => {
    const fixture = emptyFixture();
    fixture.authoredIssues.octocat = [{ repo: "aicom", number: 7, url: "" }];
    // Same person, and an association that would otherwise qualify.
    fixture.comments["aicom#7"] = [
      { authorLogin: "octocat", authorAssociation: "OWNER", body: "bump" },
      { authorLogin: "octocat", authorAssociation: "COLLABORATOR", body: "still broken?" },
    ];

    const { result } = await proveAndRedeem(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_CONTRIBUTION");
  });

  it("earns Insider for an issue a maintainer answered", async () => {
    const fixture = emptyFixture();
    fixture.authoredIssues.octocat = [{ repo: "aicom", number: 7, url: "" }];
    fixture.comments["aicom#7"] = [
      { authorLogin: "octocat", authorAssociation: "NONE", body: "found a bug" },
      { authorLogin: OWNER, authorAssociation: "OWNER", body: "thanks — reproduced, fixing" },
    ];

    const { result } = await proveAndRedeem(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.basis).toBe("issue");
  });

  it("earns Insider for a merged pull request", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 11, url: "" }];
    const { result } = await proveAndRedeem(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.basis).toBe("pr");
  });

  it("refuses (never grants) when GitHub cannot be reached", async () => {
    const fixture = emptyFixture();
    const failing: GithubPublicReader = {
      listPublicGists: async () => {
        throw new Error("network down");
      },
      listIssueComments: async () => [],
      searchMergedPullRequests: async () => [],
      searchAuthoredIssues: async () => [],
    };
    const gate = new InsiderGate({
      owner: OWNER,
      store,
      github: failing,
      log: nullLogger,
      audit,
      proofIssue: PROOF_ISSUE,
      codeTtlMs: TTL_MS,
      now: () => clock,
    });
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    const refused = await gate.redeem({ discordId: "d1" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("GITHUB_UNAVAILABLE");
    expect(store.size).toBe(0);
    void fixture;
  });
});

// ---------------------------------------------------------------------------
// The operator path for a confirmed MOMUS finding
// ---------------------------------------------------------------------------

describe("confirmed MOMUS finding", () => {
  it("needs an operator, and touches GitHub not at all", async () => {
    const { gate, calls } = buildGate(emptyFixture());

    const notOperator = await gate.grantForConfirmedFinding({
      discordId: "d9",
      operatorKey: "dc:someone",
      operatorIsKeeper: false,
    });
    expect(notOperator.ok).toBe(false);
    if (!notOperator.ok) expect(notOperator.code).toBe("NOT_OPERATOR");

    const granted = await gate.grantForConfirmedFinding({
      discordId: "d9",
      operatorKey: "dc:keeper1",
      operatorIsKeeper: true,
      lead: "MOMUS-2026-0007",
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(granted.basis).toBe("finding");
    // MOMUS intake is anonymous: no account is invented for the finder.
    expect(granted.record.github_login).toBe("");
    // No automated link between an anonymous report and a person: zero API calls.
    expect(calls).toEqual([]);
    expect(audit.entries[0]?.actor).toBe("dc:keeper1");
  });
});

// ---------------------------------------------------------------------------
// Stars — deliberately absent
// ---------------------------------------------------------------------------

describe("no star check anywhere", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sources = [
    "../src/community/access.ts",
    "../src/community/github.ts",
    "../src/community/store.ts",
    "../src/community/index.ts",
    "../src/provision/structure.ts",
    "../src/provision/discord.ts",
  ].map((rel) => join(here, rel));

  it("names no star route or star field in its source (dist is compiled from these bytes)", () => {
    const forbidden = ["/starred", "stargazer", "starred_at"];
    for (const file of sources) {
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const token of forbidden) {
        expect(text, `${file} must not mention ${token}`).not.toContain(token);
      }
    }
  });

  it("calls no star route while granting access", async () => {
    const fixture = emptyFixture();
    fixture.authoredIssues.octocat = [{ repo: "aicom", number: 7, url: "" }];
    fixture.comments["aicom#7"] = [
      { authorLogin: OWNER, authorAssociation: "OWNER", body: "on it" },
    ];
    const { gate, calls, touched } = buildGate(fixture);
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.gists.octocat = [gist(issued.code)];
    expect((await gate.redeem({ discordId: "d1" })).ok).toBe(true);

    // Routes actually served: gists, issue comments, two searches. Nothing else.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.toLowerCase()).not.toMatch(/star/);
    }
    // And nothing star-shaped was even reached for on the client.
    for (const prop of touched) {
      expect(prop.toLowerCase()).not.toMatch(/star/);
    }
    expect(new Set(touched)).toEqual(
      new Set(["listPublicGists", "searchMergedPullRequests", "searchAuthoredIssues", "listIssueComments"]),
    );
  });

  it("records no star flag on the granted row", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 5, url: "" }];
    const { gate } = buildGate(fixture);
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.gists.octocat = [gist(issued.code)];
    const granted = await gate.redeem({ discordId: "d1" });
    expect(granted.ok).toBe(true);
    if (granted.ok) expect(granted.message.toLowerCase()).not.toContain("star");
    expect(JSON.stringify(rosterOnDisk()).toLowerCase()).not.toContain("star");
  });
});

// ---------------------------------------------------------------------------
// Provisioning: one role, two channels
// ---------------------------------------------------------------------------

describe("provision plan", () => {
  it("creates exactly one new role — Insider — and no second tier", () => {
    const plan = planProvision([]);
    const roles = plan.filter((s) => s.op === "createRole").map((s) => s.name);
    // The house had two roles before this feature; Insider is the only addition.
    expect(roles).toEqual(["Keeper", "canon-reader", INSIDER_ROLE]);
    const added = roles.filter((r) => r !== "Keeper" && r !== "canon-reader");
    expect(added).toEqual([INSIDER_ROLE]);
    // No cosmetic/engagement tier may appear under any name.
    for (const role of DESIRED_STRUCTURE.roles) {
      expect(role.name.toLowerCase()).not.toMatch(/star|supporter|patron|sponsor|vip|booster|fan/);
    }
  });

  it("gives Insider no guild permissions and keeps it unmentionable", () => {
    const insider = DESIRED_STRUCTURE.roles.find((r) => r.name === INSIDER_ROLE);
    expect(insider).toBeDefined();
    expect(insider?.permissions).toEqual([]);
    expect(insider?.mentionable).toBe(false);
  });

  it("declares #momus-bulletin public-read and #momus-insiders role-gated", () => {
    const channels = DESIRED_STRUCTURE.categories.flatMap((c) => c.channels);
    const bulletin = channels.find((c) => c.name === MOMUS_BULLETIN_CHANNEL);
    const insiders = channels.find((c) => c.name === MOMUS_INSIDERS_CHANNEL);
    // readonly = @everyone may VIEW, only the bot may post. Public by design.
    expect(bulletin?.overwrites).toBe("readonly");
    expect(insiders?.overwrites).toBe("insidersonly");

    const plan = planProvision([]);
    const perms = plan.filter((s) => s.op === "setPermissions");
    expect(perms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: MOMUS_BULLETIN_CHANNEL, overwrites: "readonly" }),
        expect.objectContaining({ name: MOMUS_INSIDERS_CHANNEL, overwrites: "insidersonly" }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Data minimisation
// ---------------------------------------------------------------------------

describe("roster", () => {
  it("persists exactly the four allowed fields and nothing else", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 5, url: "https://example.test/pr/5" }];
    const { gate } = buildGate(fixture);
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.gists.octocat = [gist(issued.code)];
    expect((await gate.redeem({ discordId: "d1" })).ok).toBe(true);

    const rows = rosterOnDisk().insiders;
    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0] ?? {}).sort();
    expect(keys).toEqual([...INSIDER_FIELDS].sort());
    expect(INSIDER_FIELDS).toEqual(["discord_id", "github_login", "granted_at", "basis"]);
    // Spot-check the shape of the values as well as the names.
    expect(rows[0]).toEqual({
      discord_id: "d1",
      github_login: "octocat",
      granted_at: new Date(NOW).toISOString(),
      basis: "pr",
    });
  });

  it("strips any extra field a hand-edited roster file adds", async () => {
    writeFileSync(
      join(dir, "insiders.json"),
      JSON.stringify({
        insiders: [
          {
            discord_id: "d1",
            github_login: "octocat",
            granted_at: new Date(NOW).toISOString(),
            basis: "pr",
            email: "octocat@example.test",
            stars: 3,
            activity: ["seen 2026-08-01"],
          },
        ],
      }),
      "utf8",
    );
    const reloaded = new InsiderStore(dir, nullLogger);
    expect(Object.keys(reloaded.get("d1") ?? {}).sort()).toEqual([...INSIDER_FIELDS].sort());
    // And the smuggled fields do not survive the next write either.
    await reloaded.forget("nobody");
    await reloaded.grant({
      discord_id: "d2",
      github_login: "hubot",
      granted_at: new Date(NOW).toISOString(),
      basis: "issue",
    });
    const text = readFileSync(join(dir, "insiders.json"), "utf8");
    expect(text).not.toContain("email");
    expect(text).not.toContain("activity");
    expect(text.toLowerCase()).not.toContain("star");
  });

  it("deletes a person's row on request — forgotten, not flagged", async () => {
    const fixture = emptyFixture();
    fixture.mergedPrs.octocat = [{ repo: "aicom", number: 5, url: "" }];
    const revoked: string[] = [];
    const { github } = makeGithub(fixture);
    const gate = new InsiderGate({
      owner: OWNER,
      store,
      github,
      log: nullLogger,
      audit,
      proofIssue: PROOF_ISSUE,
      codeTtlMs: TTL_MS,
      now: () => clock,
      roleGranter: {
        grantRole: async () => undefined,
        revokeRole: async (id) => {
          revoked.push(id);
        },
      },
    });
    const issued = gate.startChallenge({ discordId: "d1", githubLogin: "octocat" });
    if (!issued.ok) throw new Error("challenge not issued");
    fixture.gists.octocat = [gist(issued.code)];
    expect((await gate.redeem({ discordId: "d1" })).ok).toBe(true);

    const forgotten = await gate.forget({ discordId: "d1", actor: "self" });
    expect(forgotten.ok).toBe(true);
    if (forgotten.ok) expect(forgotten.deleted).toBe(true);
    expect(store.has("d1")).toBe(false);
    expect(revoked).toEqual(["d1"]);
    // Nothing left behind: no row, no tombstone, no "was an insider" marker.
    expect(rosterOnDisk().insiders).toEqual([]);
    expect(JSON.stringify(rosterOnDisk())).not.toContain("d1");
    expect(new InsiderStore(dir, nullLogger).size).toBe(0);
    expect(audit.entries.map((e) => e.kind)).toEqual(["insiders.grant", "insiders.forget"]);

    // Forgetting twice is not an error, and there is nothing left to delete.
    const again = await gate.forget({ discordId: "d1" });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.deleted).toBe(false);
  });
});
