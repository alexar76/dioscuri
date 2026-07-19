/**
 * PROVISION tests — pure diff logic (structure.ts) and the one-time opening
 * feast (opening.ts). No network, no SDKs: planProvision is a pure function,
 * and postOpeningFeast gets fake ChannelAdapters plus a throwaway tmp dataDir.
 *
 * Invariants under test:
 *  - empty guild → full plan, dependency-ordered (roles → categories → channels);
 *  - fully provisioned guild → EMPTY plan (idempotence);
 *  - partial gaps → only the missing pieces, parented correctly;
 *  - same-name channel in the wrong category is ADOPTED, never duplicated/moved;
 *  - the plan vocabulary contains no destructive op, ever;
 *  - the opening feast posts exactly once, gated by the flag file.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGORA_CATEGORY,
  CANON_READER_ROLE,
  ANNOUNCE_CHANNEL,
  DESIRED_STRUCTURE,
  GALLERY_SPOTLIGHT_CHANNEL,
  GATES_CATEGORY,
  KEEPER_ROLE,
  MOD_LOG_CHANNEL,
  SKY_HALL_CATEGORY,
  WATCH_CATEGORY,
  WELCOME_CHANNEL,
  findExistingChannel,
  planProvision,
  type ExistingEntity,
  type ProvisionStep,
} from "../src/provision/structure.js";
import { castorOpening, polluxOpening, postOpeningFeast } from "../src/provision/opening.js";
import type {
  AuditChainEntry,
  AuditEvent,
  AuditLog,
  ChannelAdapter,
  CrossLinks,
  Logger,
  Platform,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};

const links: CrossLinks = {
  discordInvite: "https://discord.gg/test-invite",
  telegramChannel: "https://t.me/test_channel",
  telegramBot: "",
  siteUrl: "https://example.test",
  githubOrg: "https://github.com/example",
  theorosUrl: "https://alexar76.github.io/theoros/",
};

/** Build the ExistingEntity view of a guild that exactly matches the target. */
function fullyProvisioned(): ExistingEntity[] {
  const out: ExistingEntity[] = [];
  let id = 1;
  for (const role of DESIRED_STRUCTURE.roles) {
    out.push({ id: String(id++), name: role.name, type: "role" });
  }
  for (const cat of DESIRED_STRUCTURE.categories) {
    out.push({ id: String(id++), name: cat.name, type: "category" });
    for (const ch of cat.channels) {
      out.push({ id: String(id++), name: ch.name, type: ch.type, parentName: cat.name });
    }
  }
  return out;
}

const CREATE_OPS = new Set(["createRole", "createCategory", "createText", "createVoice", "createForum"]);
const ALLOWED_OPS = new Set([...CREATE_OPS, "setPermissions"]);

function opsOf(plan: ProvisionStep[], op: ProvisionStep["op"]): ProvisionStep[] {
  return plan.filter((s) => s.op === op);
}

// ---------------------------------------------------------------------------
// planProvision
// ---------------------------------------------------------------------------

describe("planProvision", () => {
  it("plans the full structure for an empty guild, in dependency order", () => {
    const plan = planProvision([]);

    // Everything the target declares gets created exactly once.
    const desiredChannelCount = DESIRED_STRUCTURE.categories.reduce((n, c) => n + c.channels.length, 0);
    expect(opsOf(plan, "createRole")).toHaveLength(DESIRED_STRUCTURE.roles.length);
    expect(opsOf(plan, "createCategory")).toHaveLength(DESIRED_STRUCTURE.categories.length);
    expect(opsOf(plan, "createText").length + opsOf(plan, "createVoice").length + opsOf(plan, "createForum").length).toBe(
      desiredChannelCount,
    );
    expect(opsOf(plan, "createVoice")).toHaveLength(1);
    expect(opsOf(plan, "createForum")).toHaveLength(1);
    expect(opsOf(plan, "createForum")[0]).toMatchObject({ name: "gallery" });
    expect(opsOf(plan, "createVoice")[0]).toMatchObject({ name: "Olympus", parentName: SKY_HALL_CATEGORY });

    // Dependency order: every role before every category, every category
    // before every channel (setPermissions may interleave after its create).
    const idx = (pred: (s: ProvisionStep) => boolean) => plan.findIndex(pred);
    const lastIdx = (pred: (s: ProvisionStep) => boolean) =>
      plan.length - 1 - [...plan].reverse().findIndex(pred);
    const lastRole = lastIdx((s) => s.op === "createRole");
    const firstCategory = idx((s) => s.op === "createCategory");
    const lastCategory = lastIdx((s) => s.op === "createCategory");
    const firstChannel = idx((s) => s.op === "createText" || s.op === "createVoice" || s.op === "createForum");
    expect(lastRole).toBeLessThan(firstCategory);
    expect(lastCategory).toBeLessThan(firstChannel);

    // The Keeper role leads the plan.
    expect(plan[0]).toMatchObject({ op: "createRole", name: KEEPER_ROLE });

    // Permission policies ride along with the entities that need them.
    const perms = opsOf(plan, "setPermissions");
    const permFor = (name: string) => perms.find((s) => s.name === name);
    expect(permFor(WELCOME_CHANNEL)?.overwrites).toBe("readonly");
    expect(permFor(ANNOUNCE_CHANNEL)?.overwrites).toBe("readonly");
    expect(permFor(MOD_LOG_CHANNEL)?.overwrites).toBe("modonly");
    expect(permFor("mod-chat")?.overwrites).toBe("modonly");
    expect(permFor(WATCH_CATEGORY)?.overwrites).toBe("modonly");
    // Open channels carry no policy step.
    expect(permFor("general")).toBeUndefined();
    expect(permFor("banter")).toBeUndefined();
    expect(permFor(GALLERY_SPOTLIGHT_CHANNEL)?.overwrites).toBe("readonly");

    // Channels are parented into their categories.
    for (const step of plan) {
      if (step.op === "createText" || step.op === "createVoice" || step.op === "createForum") {
        expect(step.parentName).toBeTruthy();
      }
    }
  });

  it("returns an EMPTY plan for a fully provisioned guild (idempotence)", () => {
    expect(planProvision(fullyProvisioned())).toEqual([]);
  });

  it("matches names case-insensitively", () => {
    const shouty = fullyProvisioned().map((e) => ({
      ...e,
      name: e.name.toUpperCase(),
      parentName: e.parentName?.toUpperCase(),
    }));
    expect(planProvision(shouty)).toEqual([]);
  });

  it("creates only a missing channel inside an existing category", () => {
    const existing = fullyProvisioned().filter((e) => e.name !== "ideas");
    const plan = planProvision(existing);
    expect(plan).toEqual([{ op: "createText", name: "ideas", parentName: AGORA_CATEGORY }]);
  });

  it("creates only a missing role when everything else exists", () => {
    const existing = fullyProvisioned().filter((e) => e.type !== "role");
    const plan = planProvision(existing);
    expect(plan).toEqual([
      { op: "createRole", name: KEEPER_ROLE },
      { op: "createRole", name: CANON_READER_ROLE },
    ]);
  });

  it("adopts a same-name channel living in the wrong category — no duplicate, no move", () => {
    const existing = fullyProvisioned().map((e) =>
      e.name === "banter" ? { ...e, parentName: AGORA_CATEGORY } : e,
    );
    const plan = planProvision(existing);
    expect(plan).toEqual([]); // nothing created, nothing moved
  });

  it("does not adopt a channel of the wrong kind", () => {
    // A TEXT channel named "olympus" is not the voice hall — the voice one
    // must still be created.
    const existing = fullyProvisioned().map((e) =>
      e.name === "Olympus" ? ({ ...e, type: "text" } as ExistingEntity) : e,
    );
    const plan = planProvision(existing);
    expect(plan).toEqual([{ op: "createVoice", name: "Olympus", parentName: SKY_HALL_CATEGORY }]);
  });

  it("never emits destructive ops and never touches foreign entities", () => {
    const foreign: ExistingEntity[] = [
      { id: "x1", name: "random-junk", type: "text", parentName: "SOMEWHERE ELSE" },
      { id: "x2", name: "Old Role", type: "role" },
      { id: "x3", name: "legacy-category", type: "category" },
    ];
    for (const input of [[], foreign, [...fullyProvisioned(), ...foreign]]) {
      const plan = planProvision(input);
      for (const step of plan) {
        expect(ALLOWED_OPS.has(step.op)).toBe(true);
        expect(step.name).not.toMatch(/random-junk|Old Role|legacy-category/);
      }
    }
    // With target + junk both present, the junk changes nothing: plan is empty.
    expect(planProvision([...fullyProvisioned(), ...foreign])).toEqual([]);
  });

  it("findExistingChannel prefers the in-category match but falls back to anywhere", () => {
    const inPlace: ExistingEntity = { id: "a", name: "welcome", type: "text", parentName: GATES_CATEGORY };
    const stray: ExistingEntity = { id: "b", name: "WELCOME", type: "text", parentName: "elsewhere" };
    expect(findExistingChannel([stray, inPlace], "welcome", "text", GATES_CATEGORY)?.id).toBe("a");
    expect(findExistingChannel([stray], "welcome", "text", GATES_CATEGORY)?.id).toBe("b");
    expect(findExistingChannel([], "welcome", "text", GATES_CATEGORY)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// postOpeningFeast
// ---------------------------------------------------------------------------

function makeAdapter(platform: Platform, opts?: { fail?: boolean }) {
  const posts: string[] = [];
  const adapter: ChannelAdapter = {
    platform,
    start: async () => undefined,
    stop: async () => undefined,
    announce: async (text: string) => {
      if (opts?.fail === true) throw new Error("network down");
      posts.push(text);
    },
    isReady: () => true,
  };
  return { adapter, posts };
}

function makeAudit() {
  const events: AuditEvent[] = [];
  const audit: AuditLog = {
    append: async (ev: AuditEvent): Promise<AuditChainEntry> => {
      events.push(ev);
      return { ...ev, hash: "h".repeat(64), prevHash: "0".repeat(64) };
    },
    verify: async () => -1,
  };
  return { audit, events };
}

describe("postOpeningFeast", () => {
  const dirs: string[] = [];
  const tmpDataDir = () => {
    const d = mkdtempSync(join(tmpdir(), "dioscuri-opening-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("posts each twin's manifest once, writes the flag, audits — then goes silent", async () => {
    const dataDir = tmpDataDir();
    const tg = makeAdapter("telegram");
    const dc = makeAdapter("discord");
    const { audit, events } = makeAudit();
    const now = () => new Date("2026-07-04T12:00:00.000Z");

    await postOpeningFeast({
      telegram: tg.adapter,
      discord: dc.adapter,
      links,
      dataDir,
      log: nullLogger,
      audit,
      now,
    });

    // One post per platform, each in its twin's voice, pointing at the brother.
    expect(tg.posts).toHaveLength(1);
    expect(dc.posts).toHaveLength(1);
    expect(tg.posts[0]).toContain("CASTOR");
    expect(tg.posts[0]).toContain(links.discordInvite);
    expect(dc.posts[0]).toContain("POLLUX");
    expect(dc.posts[0]).toContain(links.telegramChannel);

    // Flag written, audit entry recorded.
    expect(existsSync(join(dataDir, "opened.flag"))).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "system.opening",
      platform: "system",
      ts: "2026-07-04T12:00:00.000Z",
      data: { telegram: true, discord: true },
    });

    // Second boot: strict no-op.
    await postOpeningFeast({
      telegram: tg.adapter,
      discord: dc.adapter,
      links,
      dataDir,
      log: nullLogger,
      audit,
      now,
    });
    expect(tg.posts).toHaveLength(1);
    expect(dc.posts).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("works with a single adapter and records the absent one as false", async () => {
    const dataDir = tmpDataDir();
    const dc = makeAdapter("discord");
    const { audit, events } = makeAudit();

    await postOpeningFeast({ discord: dc.adapter, links, dataDir, log: nullLogger, audit });

    expect(dc.posts).toHaveLength(1);
    expect(existsSync(join(dataDir, "opened.flag"))).toBe(true);
    expect(events[0]?.data).toEqual({ telegram: false, discord: true });
  });

  it("does not write the flag when every announcement fails — next boot retries", async () => {
    const dataDir = tmpDataDir();
    const broken = makeAdapter("telegram", { fail: true });
    const { audit, events } = makeAudit();

    await postOpeningFeast({ telegram: broken.adapter, links, dataDir, log: nullLogger, audit });
    expect(existsSync(join(dataDir, "opened.flag"))).toBe(false);
    expect(events).toHaveLength(0);

    // The network recovers: the feast is held on the retry.
    const healthy = makeAdapter("telegram");
    await postOpeningFeast({ telegram: healthy.adapter, links, dataDir, log: nullLogger, audit });
    expect(healthy.posts).toHaveLength(1);
    expect(existsSync(join(dataDir, "opened.flag"))).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("never throws even when the audit sink explodes", async () => {
    const dataDir = tmpDataDir();
    const tg = makeAdapter("telegram");
    const explodingAudit: AuditLog = {
      append: async () => {
        throw new Error("disk full");
      },
      verify: async () => -1,
    };
    await expect(
      postOpeningFeast({ telegram: tg.adapter, links, dataDir, log: nullLogger, audit: explodingAudit }),
    ).resolves.toBeUndefined();
    expect(tg.posts).toHaveLength(1);
    expect(existsSync(join(dataDir, "opened.flag"))).toBe(true);
  });

  it("manifests are English, in persona, and free of @everyone pings", () => {
    for (const text of [castorOpening(links), polluxOpening(links)]) {
      expect(text).not.toContain("@everyone");
      expect(text).not.toContain("@here");
      expect(text.length).toBeGreaterThan(100);
    }
    expect(castorOpening(links)).toContain("POLLUX"); // Castor points at his brother
    expect(polluxOpening(links)).toContain("CASTOR"); // and vice versa
  });
});
