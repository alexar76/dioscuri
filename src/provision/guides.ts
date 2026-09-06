/**
 * Discord channel guides — pinned ecosystem primers for every thematic room.
 *
 * Pure data + rendering: each guide lists projects with repo/demo/doc links.
 * Demo URLs come from MNEMOSYNE's README registry at seed time; blurbs are
 * curated here so newcomers instantly see what each channel is for.
 */

import type { CrossLinks } from "../types.js";
import { pickDemoScreenshotTargets } from "../mnemosyne/demo-screenshots.js";
import {
  AGORA_CATEGORY,
  CANON_CATEGORY,
  CANON_CHANNEL,
  CANON_DEBATE_CHANNEL,
  DEMO_CLINIC_CHANNEL,
  FORGE_CATEGORY,
  GALLERY_CATEGORY,
  GALLERY_CHANNEL,
  GALLERY_SPOTLIGHT_CHANNEL,
  GATES_CATEGORY,
  SKY_HALL_CATEGORY,
} from "./structure.js";

/** Post template pinned in #gallery-spotlight — copy into a new #gallery forum post. */
export const GALLERY_POST_TEMPLATE = [
  "**What:** one sentence — what you built",
  "**Link:** repo / demo / screenshot / 30s video",
  "**Stack:** factory · oracle · aimarket · argus · helios · course-lab",
  "**Stuck on:** (optional) where you need help",
].join("\n");

export const DISCORD_GUIDE_MARKER = "ECOSYSTEM GUIDE ·";
export const TELEGRAM_ECOSYSTEM_MARKER = "ECOSYSTEM GUIDE · TELEGRAM";
export const ECOSYSTEM_THEMES: readonly {
  title: string;
  intro: string;
  projects: readonly GuideProject[];
}[] = [
  {
    title: "AI Factory",
    intro: "Autonomous product pipeline — specs, builds, landing pages, releases on GitHub.",
    projects: [
      { repo: "aicom", name: "AI Factory (core)", tagline: "Orchestration, agents, and the product pipeline." },
      { repo: "aicom-landing", name: "Landing generator", tagline: "Marketing landing pages for shipped products." },
      { repo: "pulse-terminal", name: "Pulse Terminal", tagline: "Terminal-style pulse view of factory activity." },
    ],
  },
  {
    title: "Oracle family",
    intro: "Verifiable answers — LUMEN trust, CHRONOS time, PLATON structured truth, and more.",
    projects: [
      { repo: "oracles", name: "Oracle hub", tagline: "Portal and demos for the oracle family." },
      { repo: "platon", name: "PLATON", tagline: "Structured truth layers for agent decisions." },
    ],
  },
  {
    title: "AIMarket",
    intro: "Agent economy — paid MCP invokes, plugin hub, widgets, SDKs.",
    projects: [
      { repo: "aimarket-hub", name: "Hub", tagline: "Plugin hub and federation for agent tools." },
      { repo: "aimarket-protocol", name: "Protocol", tagline: "Paid invokes and the agent-economy wire protocol." },
      { repo: "aimarket-widget", name: "Widget", tagline: "Embeddable widget demos for sites and apps." },
      { repo: "aimarket-courses", name: "Courses", tagline: "Learning paths for the agent economy." },
    ],
  },
  {
    title: "ARGUS & WARDEN",
    intro: "Personal agent arena plus the WARDEN MCP firewall.",
    projects: [
      { repo: "argus", name: "ARGUS", tagline: "Personal agent stack — arena, tools, WARDEN integration." },
    ],
  },
  {
    title: "Observatory",
    intro: "See the whole ecosystem at a glance.",
    projects: [
      {
        repo: "alien-monitor",
        name: "Alien Monitor",
        tagline: "3D observatory — live health, repos, and demos in one view.",
      },
    ],
  },
];

export interface GuideProject {
  /** GitHub repo slug under githubOwner. */
  repo: string;
  name: string;
  tagline: string;
}

export interface ChannelGuideDef {
  channel: string;
  category: string;
  title: string;
  intro: string;
  projects?: readonly GuideProject[];
  footer?: string;
  /** Pin the guide message when the bot can. */
  pin?: boolean;
}

export interface GuideRenderContext {
  links: CrossLinks;
  githubOwner: string;
  demoUrls: Readonly<Record<string, string>>;
}

/** All public-facing channels that get a seeded guide (mod rooms excluded). */
export const CHANNEL_GUIDES: readonly ChannelGuideDef[] = [
  {
    channel: "announcements",
    category: GATES_CATEGORY,
    title: "Announcements",
    intro:
      "Official news from the twins — **GitHub releases**, ecosystem milestones, and curated highlights from THEOXENIA (spotlights, digests). Read-only; follow this channel if your server wants our release feed.",
    pin: true,
  },
  {
    channel: "general",
    category: AGORA_CATEGORY,
    title: "The open square",
    intro: "Talk about anything in the **AICOM ecosystem**. Pollux and Castor share one memory (MNEMOSYNE) — ask in **#help** for focused questions.",
    projects: [
      {
        repo: "alien-monitor",
        name: "Alien Monitor",
        tagline: "3D observatory of the whole ecosystem — live health, repos, and demos in one view.",
      },
      {
        repo: "aicom",
        name: "AI Factory",
        tagline: "Autonomous product pipeline at the centre of the ecosystem.",
      },
      {
        repo: "argus",
        name: "ARGUS",
        tagline: "Personal agent stack with the WARDEN MCP firewall.",
      },
    ],
    footer: "Explore the projects below — each links to its repo, live demo, and README manual.",
    pin: true,
  },
  {
    channel: "help",
    category: AGORA_CATEGORY,
    title: "Ask the twins",
    intro:
      "No question too small. Mention **@Pollux** or use `/ask` — answers come from **MNEMOSYNE**, synced from our GitHub (READMEs, releases, live showcase). The twins do not invent what they do not know.",
    footer:
      "Tips: one topic per message · link a repo name if you can · English is the default tongue · no price talk or investment advice (house law #3).",
    pin: true,
  },
  {
    channel: "ideas",
    category: AGORA_CATEGORY,
    title: "Proposals & wild schemes",
    intro:
      "Feature wishes, pipeline ideas, oracle designs, agent-economy experiments. Argue with ideas, not people (house law #1). Keepers and the community read here — open a GitHub issue when a idea is ready to ship.",
    footer: "When an idea becomes code, open a post in **#gallery** (THE GALLERY).",
    pin: true,
  },
  {
    channel: CANON_CHANNEL,
    category: CANON_CATEGORY,
    title: "The canon column",
    intro:
      "**THEOROS** posts the weekly **Agent Sovereignty Canon** here — seven precepts, grounded in shipped code. Read-only for everyone; this is the constitution, not the debate hall.",
    projects: [
      {
        repo: "theoros",
        name: "THEOROS",
        tagline: "Canon corpus, granite landing, amendable precepts — runtime via DIOSCURI.",
      },
    ],
    footer: "Debate each chapter in **#canon-debate**. Full text: alexar76/theoros CANON.md.",
    pin: true,
  },
  {
    channel: CANON_DEBATE_CHANNEL,
    category: CANON_CATEGORY,
    title: "Canon debate",
    intro:
      "Argue with the precepts — amendments, benchmark evidence, Council vs Solo submissions. Pollux and Keepers moderate; **THEOROS** does not answer every message here.",
    footer: "Propose amendments via PR to **alexar76/theoros** · CvS tracks in **#gallery** with `[CvS-R/L/T/N]`.",
    pin: true,
  },
  {
    channel: GALLERY_SPOTLIGHT_CHANNEL,
    category: GALLERY_CATEGORY,
    title: "Gallery spotlight & roll call",
    intro:
      "Pollux posts the weekly **show-and-tell roll call** here. Keepers pin the best builds from **#gallery**. Read-only for everyone else — post your work in the forum.",
    footer: `Copy this into a new **#${GALLERY_CHANNEL}** post:\n\n${GALLERY_POST_TEMPLATE}`,
    pin: true,
  },
  {
    channel: DEMO_CLINIC_CHANNEL,
    category: GALLERY_CATEGORY,
    title: "Demo clinic",
    intro:
      "Bring a demo link or screenshot and ask for **grounded feedback**. One topic per message; mention your stack tag so Pollux can cite the right KB docs.",
    footer: "When it ships, move the story to **#gallery** for the wider audience.",
    pin: true,
  },
  {
    channel: "factory",
    category: FORGE_CATEGORY,
    title: "AI Factory",
    intro:
      "The **autonomous product pipeline** — specs, builds, landing pages, and releases wired to GitHub. This channel is for Factory architecture, pipeline runs, and shipping stories.",
    projects: [
      {
        repo: "aicom",
        name: "AI Factory (core)",
        tagline: "Main factory repo — orchestration, agents, and the product pipeline.",
      },
      {
        repo: "aicom-landing",
        name: "Landing generator",
        tagline: "Generates marketing landing pages for shipped products.",
      },
      {
        repo: "pulse-terminal",
        name: "Pulse Terminal",
        tagline: "Terminal-style pulse view of factory activity.",
      },
    ],
    pin: true,
  },
  {
    channel: "oracles",
    category: FORGE_CATEGORY,
    title: "Oracle family",
    intro:
      "**Verifiable answers** — on-chain and off-chain oracles (LUMEN trust, CHRONOS time, PLATON structured truth, and the wider family). Architecture, proofs, and integrations live here.",
    projects: [
      {
        repo: "oracles",
        name: "Oracle hub",
        tagline: "Portal and demos for the oracle family.",
      },
      {
        repo: "platon",
        name: "PLATON",
        tagline: "Structured truth layers for agent and contract decisions.",
      },
    ],
    pin: true,
  },
  {
    channel: "aimarket",
    category: FORGE_CATEGORY,
    title: "AIMarket",
    intro:
      "The **agent economy** — paid MCP invokes, plugin hub, widgets, and SDKs. Builders and integrators: this is your forge bench.",
    projects: [
      {
        repo: "aimarket-hub",
        name: "Hub",
        tagline: "Plugin hub and federation for agent tools.",
      },
      {
        repo: "aimarket-protocol",
        name: "Protocol",
        tagline: "Paid invokes and the agent-economy wire protocol.",
      },
      {
        repo: "aimarket-widget",
        name: "Widget",
        tagline: "Embeddable widget demos for sites and apps.",
      },
      {
        repo: "aimarket-courses",
        name: "Courses",
        tagline: "Learning paths for the agent economy.",
      },
    ],
    pin: true,
  },
  {
    channel: "argus",
    category: FORGE_CATEGORY,
    title: "ARGUS & WARDEN",
    intro:
      "**ARGUS** — personal agent arena. **WARDEN** — MCP firewall that gates what your agent can reach. Security models, tool policies, and agent UX belong here.",
    projects: [
      {
        repo: "argus",
        name: "ARGUS",
        tagline: "Personal agent stack — arena, tools, and WARDEN integration.",
      },
    ],
    pin: true,
  },
  {
    channel: "banter",
    category: SKY_HALL_CATEGORY,
    title: "Off-topic & twin contest",
    intro:
      "Memes, side quests, and the eternal Pollux-vs-Castor rivalry. Still house law #1: be kind. Financial hype stays out (law #3).",
    footer: "For ecosystem work, use **#general** or the forge channels.",
    pin: true,
  },
];

export function guideMarker(channel: string): string {
  return `${DISCORD_GUIDE_MARKER} #${channel}`;
}

export function guideFlagKey(channel: string): string {
  return `discord-guide-${channel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Bumped when screenshot QC improves — triggers one-time guide refresh per channel. */
export function guideScreenshotFlagKey(channel: string): string {
  return `${guideFlagKey(channel)}-shots-v3`;
}

function repoUrl(ctx: GuideRenderContext, repo: string): string {
  const base = ctx.links.githubOrg.replace(/\/+$/, "");
  return `${base}/${repo}`;
}

function projectBlockPlain(p: GuideProject, ctx: GuideRenderContext): string {
  const lines = [`${p.name} (${p.repo})`, p.tagline];
  const demo = ctx.demoUrls[p.repo];
  if (demo !== undefined && demo !== "") lines.push(`Demo: ${demo}`);
  lines.push(`Repo: ${repoUrl(ctx, p.repo)}`);
  lines.push(`Manual: README in repo`);
  return lines.join("\n");
}

function renderPlatformFooter(ctx: GuideRenderContext): string[] {
  const lines = [
    "",
    "Two heavens, one memory — English is the default community language.",
    "Castor on Telegram · Pollux on Discord. Ask either twin; we share MNEMOSYNE.",
  ];
  if (ctx.links.discordInvite !== "") lines.push(`Discord (Pollux): ${ctx.links.discordInvite}`);
  if (ctx.links.telegramChannel !== "") lines.push(`Telegram channel (Castor): ${ctx.links.telegramChannel}`);
  if (ctx.links.telegramBot !== "") lines.push(`Talk to Castor (bot): ${ctx.links.telegramBot}`);
  lines.push(`Site: ${ctx.links.siteUrl}`);
  lines.push(`GitHub: ${ctx.links.githubOrg}`);
  return lines;
}

export function telegramGuideFlagKey(): string {
  return "telegram-ecosystem-lock";
}

/** Full ecosystem primer for Castor's Telegram channel (English, plain text). */
export function renderTelegramEcosystemGuide(ctx: GuideRenderContext): string {
  const lines = [
    `📖 ${TELEGRAM_ECOSYSTEM_MARKER}`,
    "",
    "THE HOUSE OF THE TWINS",
    "",
    "You landed in Castor's ground — fast news, releases, and answers on Telegram.",
    "My brother Pollux holds Discord: forge channels (#factory, #oracles, #aimarket, #argus),",
    "THE GALLERY (#gallery forum), voice hall Olympus, and deep technical threads.",
    "",
    "One shared memory — MNEMOSYNE — synced from the ecosystem GitHub.",
    "Everything we post proactively is in English. Ask in any language; we mirror yours in replies.",
    "",
    "Commands: /start · /ask · /links · /help",
  ];

  for (const theme of ECOSYSTEM_THEMES) {
    lines.push("", `—— ${theme.title.toUpperCase()} ——`, theme.intro, "");
    for (const p of theme.projects) {
      lines.push(projectBlockPlain(p, ctx), "");
    }
  }

  lines.push(
    "—— HOW TO USE THIS CHANNEL ——",
    "Ask anything about AICOM — mention the bot or use /ask.",
    "Releases and curated highlights land here first (Castor hurries).",
    "For forge-depth, voice, and the builders' gallery → join Pollux on Discord.",
    ...renderPlatformFooter(ctx),
    "",
    "These are the only official links. Fakes claiming to be us — report to admins.",
  );

  return lines.join("\n").trim();
}

function projectBlock(p: GuideProject, ctx: GuideRenderContext): string {
  const lines = [`**${p.name}** (\`${p.repo}\`)`, p.tagline];
  const demo = ctx.demoUrls[p.repo];
  if (demo !== undefined && demo !== "") lines.push(`🌐 Demo: ${demo}`);
  lines.push(`🐙 Repo: ${repoUrl(ctx, p.repo)}`);
  lines.push(`📄 Manual: README in repo`);
  return lines.join("\n");
}

/** Render guide text (≤ Discord 2000 chars when possible). */
export function renderChannelGuide(def: ChannelGuideDef, ctx: GuideRenderContext): string {
  const lines = [
    `📖 **${guideMarker(def.channel)}**`,
    "",
    `**${def.title}**`,
    "",
    def.intro,
    "",
    "**English** is the default language. **Castor** on Telegram · **Pollux** on Discord — one memory (MNEMOSYNE).",
  ];

  if (def.projects !== undefined && def.projects.length > 0) {
    lines.push("", "---", "");
    for (const p of def.projects) {
      lines.push(projectBlock(p, ctx), "");
    }
  }

  if (def.footer !== undefined && def.footer !== "") {
    lines.push(def.footer);
  }

  for (const foot of renderPlatformFooter(ctx)) {
    lines.push(foot.startsWith("\n") ? foot.slice(1) : foot);
  }

  let text = lines.join("\n").trim();
  if (text.length > 2000) {
    text = `${text.slice(0, 1990)}…`;
  }
  return text;
}

/** Demo URLs to screenshot for a guide (filtered, ranked, deduped). */
export function guideDemoTargets(
  def: ChannelGuideDef,
  demoUrls: Readonly<Record<string, string>>,
  max = 4,
): { repo: string; url: string }[] {
  if (def.projects === undefined) return [];
  const entries = def.projects
    .map((p) => ({ repo: p.repo, url: demoUrls[p.repo] ?? "" }))
    .filter((e) => e.url !== "");
  return pickDemoScreenshotTargets(entries, max);
}

/** All unique demo URLs for Telegram photo album (filtered + ranked, cap 6). */
export function telegramDemoTargets(
  demoUrls: Readonly<Record<string, string>>,
  max = 6,
): { repo: string; url: string }[] {
  const entries: { repo: string; url: string }[] = [];
  for (const theme of ECOSYSTEM_THEMES) {
    for (const p of theme.projects) {
      const url = demoUrls[p.repo];
      if (url !== undefined && url !== "") entries.push({ repo: p.repo, url });
    }
  }
  return pickDemoScreenshotTargets(entries, max);
}
