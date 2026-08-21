/**
 * PROVISION / structure — the desired shape of Pollux's heaven, as pure data.
 *
 * This file knows NOTHING about discord.js (and must stay that way): it holds
 * the declarative target structure of the Discord server and a pure diff
 * function that turns "what exists" into "what to create". The executor
 * (src/provision/discord.ts) owns all API calls.
 *
 * Contract:
 *  - MINIMAL IDEMPOTENT DIFF: planProvision creates ONLY what is missing.
 *    It NEVER emits delete, rename or move operations — an admin's manual
 *    rearrangement is law. A same-name channel of the right kind anywhere in
 *    the guild is adopted as-is (preferring one inside the desired category).
 *  - Name matching is case-insensitive (Discord lowercases text channels).
 *  - Dependency order: roles → categories → channels, so every step can rely
 *    on its prerequisites already existing when executed sequentially.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType = "category" | "text" | "voice" | "forum" | "role";

/** Snapshot of one thing that already exists in the guild (id = platform id). */
export interface ExistingEntity {
  id: string;
  name: string;
  type: EntityType;
  /** Category name for channels that live inside one. */
  parentName?: string;
}

/**
 * Permission policy applied by the executor (see discord.ts for semantics).
 *
 * `insidersonly` is deliberately its own policy rather than a parameter on
 * `modonly`: the two hide a channel from @everyone for opposite reasons (staff
 * business vs. earned commentary), and collapsing them would make it a one-word
 * edit to open the Keepers' war room to a community role.
 */
export type OverwritePolicy = "readonly" | "modonly" | "insidersonly";

export type ProvisionOp =
  | "createRole"
  | "createCategory"
  | "createText"
  | "createVoice"
  | "createForum"
  | "setPermissions";

export interface ProvisionStep {
  op: ProvisionOp;
  name: string;
  parentName?: string;
  overwrites?: OverwritePolicy;
}

/** Guild-level permissions the Keeper role needs (mapped to bits in discord.ts). */
export type KeeperPermission = "ManageMessages" | "ModerateMembers";

export interface DesiredRole {
  name: string;
  /** Discord colour integer. */
  color: number;
  mentionable: boolean;
  permissions: readonly KeeperPermission[];
}

export interface DesiredChannel {
  name: string;
  type: "text" | "voice" | "forum";
  overwrites?: OverwritePolicy;
  /** Channel topic (text and forum channels). */
  topic?: string;
  /** Forum tag names (forum channels only). */
  forumTags?: readonly string[];
}

export interface DesiredCategory {
  name: string;
  /** Category-level policy (children created inside inherit intent explicitly). */
  overwrites?: OverwritePolicy;
  channels: readonly DesiredChannel[];
}

export interface DesiredStructure {
  roles: readonly DesiredRole[];
  categories: readonly DesiredCategory[];
}

// ---------------------------------------------------------------------------
// Well-known names (single source of truth for the executor and index.ts)
// ---------------------------------------------------------------------------

export const KEEPER_ROLE = "Keeper";
export const CANON_READER_ROLE = "canon-reader";
/**
 * The ONE role the insiders gate grants (src/community/access.ts). Named here
 * because the gate and the provisioner must not be able to disagree about it:
 * a role the gate hands out but the provisioner never creates is a grant that
 * silently does nothing.
 */
export const INSIDER_ROLE = "Insider";
export const GATES_CATEGORY = "📜 THE GATES";
export const AGORA_CATEGORY = "🏛 THE AGORA";
export const CANON_CATEGORY = "📜 THE CANON";
export const GALLERY_CATEGORY = "🖼 THE GALLERY";
export const FORGE_CATEGORY = "🔨 THE FORGE";
export const GALLERY_CHANNEL = "gallery";
export const GALLERY_SPOTLIGHT_CHANNEL = "gallery-spotlight";
export const DEMO_CLINIC_CHANNEL = "demo-clinic";
export const SKY_HALL_CATEGORY = "🌌 THE SKY HALL";
export const WATCH_CATEGORY = "🛡 THE WATCH";
export const WELCOME_CHANNEL = "welcome";
export const GENERAL_CHANNEL = "general";
export const ANNOUNCE_CHANNEL = "announcements";
export const CANON_CHANNEL = "the-canon";
export const CANON_DEBATE_CHANNEL = "canon-debate";
export const MOD_LOG_CHANNEL = "mod-log";
export const BULLETIN_CATEGORY = "🛰 THE BULLETIN";
export const MOMUS_BULLETIN_CHANNEL = "momus-bulletin";
export const MOMUS_INSIDERS_CHANNEL = "momus-insiders";

/** Steel blue — the twins' star-metal livery. */
const STEEL_BLUE = 0x4682b4;

/** Parchment gold — canon reader opt-in role. */
const PARCHMENT_GOLD = 0xc9a227;

/**
 * No colour (Discord "Default") — for Insider, on purpose.
 *
 * A coloured, hoisted name IS the cosmetic tier this feature refused to build:
 * it turns a key into a badge, and a badge is the thing people then farm for.
 * Insider opens one channel and is invisible everywhere else.
 */
const NO_COLOUR = 0;

/** Tags for #gallery forum posts — one stack per tag. */
export const GALLERY_FORUM_TAGS = [
  "factory",
  "oracle",
  "mcp",
  "agent",
  "course-lab",
  "integration",
  "wip",
  "help-wanted",
] as const;

// ---------------------------------------------------------------------------
// The desired server
// ---------------------------------------------------------------------------

export const DESIRED_STRUCTURE: DesiredStructure = {
  roles: [
    {
      name: KEEPER_ROLE,
      color: STEEL_BLUE,
      mentionable: true,
      permissions: ["ManageMessages", "ModerateMembers"],
    },
    {
      name: CANON_READER_ROLE,
      color: PARCHMENT_GOLD,
      mentionable: true,
      permissions: [],
    },
    {
      // The only role the insiders gate adds, and it carries NO guild
      // permissions: its entire power is one channel overwrite
      // (#momus-insiders). A role with permissions of its own is a role that
      // accumulates more of them, and this one is handed out by a bot.
      // Unmentionable, so holding it can never become a ping list of the
      // people who contributed — they earned access, not an audience role.
      name: INSIDER_ROLE,
      color: NO_COLOUR,
      mentionable: false,
      permissions: [],
    },
  ],
  categories: [
    {
      name: GATES_CATEGORY,
      channels: [
        {
          name: WELCOME_CHANNEL,
          type: "text",
          overwrites: "readonly",
          topic: "Rules and official links — start here.",
        },
        {
          name: ANNOUNCE_CHANNEL,
          type: "text",
          overwrites: "readonly",
          topic: "Releases and ecosystem news, straight from the twins.",
        },
      ],
    },
    {
      name: AGORA_CATEGORY,
      channels: [
        { name: "general", type: "text", topic: "The open square — talk about anything AICOM." },
        { name: "help", type: "text", topic: "Ask the twins or the community — no question too small." },
        { name: "ideas", type: "text", topic: "Proposals, feature wishes, wild schemes." },
      ],
    },
    {
      name: CANON_CATEGORY,
      channels: [
        {
          name: CANON_CHANNEL,
          type: "text",
          overwrites: "readonly",
          topic: "Weekly column — THEOROS drafts the Agent Sovereignty Canon. Read-only; debate in #canon-debate.",
        },
        {
          name: CANON_DEBATE_CHANNEL,
          type: "text",
          topic: "Debate each canon chapter — amendments, benchmarks, Council vs Solo.",
        },
      ],
    },
    {
      name: GALLERY_CATEGORY,
      channels: [
        {
          name: GALLERY_CHANNEL,
          type: "forum",
          topic: "Builders' gallery — one forum post per project. Tag your stack; rough edges welcome.",
          forumTags: GALLERY_FORUM_TAGS,
        },
        {
          name: GALLERY_SPOTLIGHT_CHANNEL,
          type: "text",
          overwrites: "readonly",
          topic: "Weekly roll call and spotlight picks from #gallery — Pollux posts, Keepers pin the best.",
        },
        {
          name: DEMO_CLINIC_CHANNEL,
          type: "text",
          topic: "Bring a demo; get grounded feedback from the twins and the community.",
        },
      ],
    },
    {
      name: FORGE_CATEGORY,
      channels: [
        { name: "factory", type: "text", topic: "AI Factory — the autonomous product pipeline." },
        { name: "oracles", type: "text", topic: "The oracle family — verifiable answers, on and off chain." },
        { name: "aimarket", type: "text", topic: "AIMarket — the agent economy and paid MCP invokes." },
        { name: "argus", type: "text", topic: "ARGUS personal agent and the WARDEN MCP firewall." },
      ],
    },
    {
      // The category itself carries NO policy on purpose. A gated category
      // would hide the public bulletin along with the write-ups, and "the
      // advisory is public" is the one promise this feature cannot break —
      // gating it would mean somebody running our code never learns their
      // component has an open hole. Only the write-up channel inside closes,
      // and it closes with its own overwrite.
      name: BULLETIN_CATEGORY,
      channels: [
        {
          name: MOMUS_BULLETIN_CHANNEL,
          type: "text",
          // readonly = @everyone may READ, only the bot may post. Public by
          // design; the bot is the only author because these posts repeat
          // MOMUS's accusations about named components under our own identity.
          overwrites: "readonly",
          topic:
            "MOMUS security advisories — public the moment they verify. Posted by the bot; questions welcome in #help.",
        },
        {
          name: MOMUS_INSIDERS_CHANNEL,
          type: "text",
          overwrites: "insidersonly",
          topic:
            "Write-ups, deep dives and Q&A for Insiders. The advisories themselves stay public next door in #momus-bulletin.",
        },
      ],
    },
    {
      name: SKY_HALL_CATEGORY,
      channels: [
        { name: "banter", type: "text", topic: "Off-topic, memes, and the eternal twin contest." },
        { name: "Olympus", type: "voice" },
      ],
    },
    {
      name: WATCH_CATEGORY,
      overwrites: "modonly",
      channels: [
        { name: MOD_LOG_CHANNEL, type: "text", overwrites: "modonly", topic: "Automated moderation log — every action, hash-chained." },
        { name: "mod-chat", type: "text", overwrites: "modonly", topic: "Keepers' war room." },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Diff logic
// ---------------------------------------------------------------------------

/** Case-insensitive name key (Discord lowercases text-channel names anyway). */
function norm(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Locate an existing channel for a desired one: prefer a same-name/same-type
 * channel inside the desired category; otherwise adopt one anywhere in the
 * guild (we never move channels — the admin's layout wins).
 */
export function findExistingChannel(
  existing: readonly ExistingEntity[],
  name: string,
  type: "text" | "voice" | "forum",
  parentName?: string,
): ExistingEntity | undefined {
  const matches = existing.filter((e) => e.type === type && norm(e.name) === norm(name));
  if (parentName !== undefined) {
    const inPlace = matches.find(
      (e) => e.parentName !== undefined && norm(e.parentName) === norm(parentName),
    );
    if (inPlace) return inPlace;
  }
  return matches[0];
}

/**
 * Compute the minimal creation plan. Ordering guarantees:
 *   1. all createRole steps,
 *   2. then createCategory steps (each immediately followed by its
 *      setPermissions step when the category has a policy),
 *   3. then channel creation steps (same pairing rule).
 * setPermissions is emitted ONLY for freshly created entities — existing
 * entities are adopted untouched, so a fully provisioned guild yields [].
 */
export function planProvision(existing: readonly ExistingEntity[]): ProvisionStep[] {
  const roleSteps: ProvisionStep[] = [];
  const categorySteps: ProvisionStep[] = [];
  const channelSteps: ProvisionStep[] = [];

  const existingRoles = existing.filter((e) => e.type === "role");
  const existingCategories = existing.filter((e) => e.type === "category");

  for (const role of DESIRED_STRUCTURE.roles) {
    if (!existingRoles.some((r) => norm(r.name) === norm(role.name))) {
      roleSteps.push({ op: "createRole", name: role.name });
    }
  }

  for (const cat of DESIRED_STRUCTURE.categories) {
    const catExists = existingCategories.some((c) => norm(c.name) === norm(cat.name));
    if (!catExists) {
      categorySteps.push({ op: "createCategory", name: cat.name });
      if (cat.overwrites) {
        categorySteps.push({ op: "setPermissions", name: cat.name, overwrites: cat.overwrites });
      }
    }

    for (const ch of cat.channels) {
      // Adopt any same-name channel of the right kind, wherever it lives.
      if (findExistingChannel(existing, ch.name, ch.type, cat.name)) continue;
      const op =
        ch.type === "text" ? "createText" : ch.type === "voice" ? "createVoice" : "createForum";
      channelSteps.push({
        op,
        name: ch.name,
        parentName: cat.name,
      });
      if (ch.overwrites) {
        channelSteps.push({
          op: "setPermissions",
          name: ch.name,
          parentName: cat.name,
          overwrites: ch.overwrites,
        });
      }
    }
  }

  return [...roleSteps, ...categorySteps, ...channelSteps];
}
