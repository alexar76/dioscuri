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

export type EntityType = "category" | "text" | "voice" | "role";

/** Snapshot of one thing that already exists in the guild (id = platform id). */
export interface ExistingEntity {
  id: string;
  name: string;
  type: EntityType;
  /** Category name for channels that live inside one. */
  parentName?: string;
}

/** Permission policy applied by the executor (see discord.ts for semantics). */
export type OverwritePolicy = "readonly" | "modonly";

export type ProvisionOp =
  | "createRole"
  | "createCategory"
  | "createText"
  | "createVoice"
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
  type: "text" | "voice";
  overwrites?: OverwritePolicy;
  /** Channel topic (text channels only). */
  topic?: string;
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
export const GATES_CATEGORY = "📜 THE GATES";
export const AGORA_CATEGORY = "🏛 THE AGORA";
export const FORGE_CATEGORY = "🔨 THE FORGE";
export const SKY_HALL_CATEGORY = "🌌 THE SKY HALL";
export const WATCH_CATEGORY = "🛡 THE WATCH";
export const WELCOME_CHANNEL = "welcome";
export const ANNOUNCE_CHANNEL = "announcements";
export const MOD_LOG_CHANNEL = "mod-log";

/** Steel blue — the twins' star-metal livery. */
const STEEL_BLUE = 0x4682b4;

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
        { name: "show-and-tell", type: "text", topic: "Built something? Show it. The twins keep score." },
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
  type: "text" | "voice",
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
      channelSteps.push({
        op: ch.type === "text" ? "createText" : "createVoice",
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
