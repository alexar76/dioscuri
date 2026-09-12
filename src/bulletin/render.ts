/**
 * BULLETIN / render — advisory → message, as pure data.
 *
 * This file knows NOTHING about discord.js or grammy (and must stay that way,
 * like src/provision/structure.ts): it turns a verified {@link Advisory} into a
 * plain embed description and a plain Telegram string. The sinks in ./index.ts
 * own the API calls.
 *
 * THE THREAT MODEL HERE IS THE TEXT ITSELF. An advisory summary is remote input:
 * signed, yes, but a signature authenticates a publisher, it does not make its
 * prose safe to splice into a message our own bot signs with its identity. Three
 * rules carry that weight, and each exists because breaking it produces a
 * PHISHING POST WEARING OUR BOT'S NAME — worse than having no channel at all.
 *
 * ── RULE 1. No text from the feed ever produces a clickable link. ─────────────
 *
 * ./verify.ts allow-lists the `url` FIELD to https-on-the-index-origin, and that
 * field stays the ONLY way a live link reaches the channel. Escaping markdown is
 * not enough to hold that line: Discord auto-links BARE urls in an embed
 * description and in field values, and Telegram builds url entities out of plain
 * text — including scheme-less hosts like `evil.example/x`. A summary reading
 * "Mitigation guidance: https://phishing.evil.example/fix" therefore became the
 * most trusted link in the channel while the allow-list was still "passing".
 *
 * So every feed string is DE-FANGED ({@link defangLinks}): `https://` → `https[:]//`
 * and host dots → `[.]`. Defanged, not deleted — a reader still needs to see that
 * the advisory mentioned an address, and copy-pasting it becomes a deliberate act.
 * On top of that, feed text is placed inside a code fence (Discord) or a quoted
 * region (Telegram), which stops linkification a second way. Both layers on
 * purpose: fencing is presentation and clients change; de-fanging survives a
 * client that linkifies inside code.
 *
 * ── RULE 2. Feed text can never imitate our own header. ───────────────────────
 *
 * A summary is a ONE-LINE field by contract, so {@link neutralise} collapses every
 * line break (\n, \r, U+2028, U+2029 …) to a single space: feed text cannot open a
 * new visual block, which is what a forged second header needs. On top of that the
 * feed's words live inside a fenced/quoted region our own header sits OUTSIDE of,
 * so a reader can see where our words end. And an advisory whose own text carries
 * our header markers — the bulletin glyphs or the string "MOMUS security bulletin"
 * — is REFUSED outright ({@link headerImpersonation}, {@link renderAdvisory}
 * returns null): a legitimate advisory has no reason to contain them, and refusing
 * is cheaper than reasoning about whether an imitation is convincing.
 *
 * ── RULE 3. Only allow-listed fields exist. ───────────────────────────────────
 *
 * ./verify.ts never loads `reproducer`, `evidence`, `poc` or `target`, so there is
 * no code path — present or future — by which this renderer could publish one. For
 * an `open` advisory the post says so out loud, because a non-actionable advisory
 * looks like an incomplete one unless you explain the omission is the point.
 *
 * Two further choices worth stating:
 *
 *  - **Telegram gets PLAIN text, no parse_mode.** The adapter already sends
 *    without one (src/adapters/telegram.ts). No markup language means no escaping
 *    bug is possible: remote text cannot become markup because nothing parses it.
 *    That also rules `<code>` out for the quoted region — with no parse_mode the
 *    tags would be shown, not applied — so the region is marked the plain-text way,
 *    with a `|` sigil on every feed line, and de-fanging does the anti-link work.
 *  - **Discord feed text is FENCED, not escaped.** There is deliberately no
 *    markdown escaper in this file any more. Escaping made hostile text render as
 *    its own characters but left bare urls live, which is precisely the bug above;
 *    a code fence makes the whole block inert in one move and shows the advisory's
 *    words without a hedge of backslashes.
 *
 * Mentions: nothing this bot posts can ping anyone (the Discord client is built
 * with `allowedMentions {parse: []}`), so de-fanging `@everyone` is about not
 * echoing a remote string that LOOKS like a mass ping in a channel people trust —
 * belt and braces, one layer down from the client-wide setting.
 */

import { prepareUntrusted } from "../aegis/sanitize.js";
import { truncateChars } from "../shared/index.js";
import type { Advisory, AdvisoryStatus } from "./verify.js";

/** Discord's own limits, minus headroom. */
const EMBED_TITLE_MAX = 240;
const EMBED_DESCRIPTION_MAX = 1800;
const EMBED_FIELD_VALUE_MAX = 240;
/** Telegram accepts 4096; we stay well under so nothing is ever split. */
const TELEGRAM_MAX = 3000;
/** Summary cap AFTER de-fanging (de-fanging only adds brackets). */
const SUMMARY_MAX = 700;
const COMPONENT_MAX = 80;

/**
 * Status badges. Visually distinct three ways — emoji, word, embed colour — so
 * the state of an advisory survives a colour-blind reader, a dark theme, and a
 * phone notification that shows only the first line.
 */
export const STATUS_BADGE: Record<AdvisoryStatus, { emoji: string; label: string; color: number }> = {
  open: { emoji: "🔴", label: "OPEN", color: 0xe74c3c },
  fixed: { emoji: "🟢", label: "FIXED", color: 0x2ecc71 },
  withdrawn: { emoji: "⚪", label: "WITHDRAWN", color: 0x95a5a6 },
};

/**
 * The phrase that says "this post is the bulletin, and the bulletin is us".
 * It appears in our Discord content line, our Telegram header and our embed
 * footer — and nowhere in a legitimate advisory.
 */
export const BULLETIN_HEADER_MARKER = "MOMUS security bulletin";

/**
 * Glyphs reserved for OUR OWN voice: the bulletin megaphone and the three status
 * badges above. A header is emoji + phrase + a `id · STATUS · severity` line, so
 * keeping the alphabet exclusively ours is what makes the shape unforgeable from
 * inside feed text. The cost is a legitimate advisory that decorates its summary
 * with a status circle being refused and logged; MOMUS's advisory text is
 * machine-generated and does not.
 */
const HEADER_GLYPHS = ["📢", ...Object.values(STATUS_BADGE).map((b) => b.emoji)] as const;

/** The plain-text sigil that marks a Telegram line as the feed's words, not ours. */
const QUOTE_SIGIL = "| ";

/** Embed field as plain data (names match discord.js's EmbedBuilder input). */
export interface BulletinEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Discord embed as plain data — the sink hands this to EmbedBuilder. */
export interface BulletinEmbed {
  title: string;
  /** Advisory page link, when the payload offered an allowed one. */
  url?: string;
  color: number;
  description: string;
  fields: BulletinEmbedField[];
  footer: string;
}

export type RenderKind = "new" | "update";

export interface RenderedAdvisory {
  advisoryId: string;
  kind: RenderKind;
  /** Discord: a one-line header plus the embed. */
  discord: { content: string; embed: BulletinEmbed };
  /** Telegram: one plain-text message, no parse_mode. */
  telegram: string;
}

export interface RenderOptions {
  /**
   * Base URL of the insiders' write-up, from CONFIG — never from the feed.
   * Empty (the default) renders no write-up line at all.
   *
   * This is the only "exclusivity" in the feature and it is exclusivity of
   * COMMENTARY: the advisory itself is public the moment it is published; the
   * deep dive and the Q&A happen first among people who contributed. The link is
   * public because a pointer to where the discussion lives is not the advisory.
   */
  writeupBaseUrl?: string;
}

/**
 * Render one advisory for both platforms, or NULL when we refuse to render it.
 *
 * Pure: same advisory in, same strings out. No clock, no network, no state — and
 * no logger, so the refusal is returned rather than reported; ./index.ts logs it
 * with {@link headerImpersonation} for the reason. Null rather than a throw
 * because a refusal is per-advisory: throwing from here would abort the whole
 * cycle and silence the advisories that were fine.
 */
export function renderAdvisory(
  advisory: Advisory,
  kind: RenderKind,
  opts: RenderOptions = {},
): RenderedAdvisory | null {
  // REFUSED BEFORE COMPOSITION. A post carrying two headers is a phishing post in
  // our own bot's name; there is no quoting or escaping that makes it safe.
  if (headerImpersonation(advisory) !== null) return null;

  const badge = STATUS_BADGE[advisory.status];
  // Every string below came off the wire and every one of them is neutralised
  // HERE, in the file that renders it. The charset rules in ./verify.ts already
  // constrain the id and the dates, but a guard that lives only in another file is
  // a guard that dies the day that file is edited.
  const idT = neutraliseTracked(advisory.id, 64);
  const componentT = neutraliseTracked(advisory.component, COMPONENT_MAX);
  const summaryT = neutraliseTracked(advisory.summary, SUMMARY_MAX);
  const publishedT = neutraliseTracked(advisory.published, 40);
  const modifiedT = neutraliseTracked(advisory.modified, 40);
  const severityT = neutraliseTracked(advisory.severity, 24);
  const id = idT.text;
  const component = componentT.text;
  const summary = summaryT.text;
  const published = publishedT.text;
  const modified = modifiedT.text;
  const severity = severityT.text.toUpperCase();
  const fieldsDefanged = [idT, componentT, summaryT, publishedT, modifiedT, severityT]
    .map((f) => f.defanged);
  const advisoryUrl = advisoryLink(advisory.url);
  const writeupUrl = writeupLink(advisory.id, opts.writeupBaseUrl);

  const headline = kind === "update" ? "advisory updated" : "new advisory";
  // Only claim the addresses are de-fanged when some address actually was — otherwise the
  // line is noise on every post and readers stop reading it. Taken from the neutralisation
  // itself, never by scanning its output: see neutraliseTracked.
  const defanged = fieldsDefanged.some(Boolean);

  // -- Discord -------------------------------------------------------------
  // OUR OWN lines are assembled first and the remote summary is budgeted against
  // what is left. Order of operations matters: if the description cap trimmed the
  // tail instead, a long hostile summary could push the "no reproducer, no
  // evidence" notice off the end — and a post that loses that notice reads as an
  // advisory we simply forgot to finish.
  const ownLines: string[] = [];
  if (advisory.status === "open") {
    // Say why the post is thin. Without this line a reader assumes we withheld
    // detail by accident, or goes looking for the reproducer somewhere else.
    ownLines.push(
      "⚠️ **Open advisory** — deliberately non-actionable: no reproducer, no evidence, " +
        "no target. Detail is published when the fix ships.",
    );
  }
  if (summary === "") ownLines.push("_The advisory published no summary._");
  if (defanged) ownLines.push(DEFANG_NOTICE_MD);
  if (writeupUrl !== "") {
    ownLines.push(`📝 Write-up, deep dive and Q&A first in the insiders' channel: ${writeupUrl}`);
  }
  const reserved = ownLines.reduce((n, line) => n + line.length + 2, 0) + FENCE_OVERHEAD;
  const summaryBudget = Math.max(200, EMBED_DESCRIPTION_MAX - reserved);
  const descriptionParts = summary === "" ? [...ownLines] : [fence(cap(summary, summaryBudget)), ...ownLines];

  const fields: BulletinEmbedField[] = [
    { name: "Status", value: cap(`${badge.emoji} ${badge.label}`, EMBED_FIELD_VALUE_MAX), inline: true },
    { name: "Severity", value: cap(severity, EMBED_FIELD_VALUE_MAX), inline: true },
    // Field values auto-link bare urls exactly like the description does, so the
    // feed's words live in an inline code span here too.
    { name: "Component", value: component !== "" ? inlineCode(component) : "—", inline: true },
  ];
  if (published !== "") {
    fields.push({ name: "Published", value: inlineCode(published), inline: true });
  }
  if (kind === "update" && modified !== "" && modified !== published) {
    fields.push({ name: "Updated", value: inlineCode(modified), inline: true });
  }

  const embed: BulletinEmbed = {
    // Embed titles are NOT markdown-parsed and NOT auto-linked by Discord, so the
    // id goes in as text; it is de-fanged like everything else from the feed, and
    // one line by construction, so it cannot grow a second header row.
    title: cap(`${badge.emoji} ${id} · ${badge.label} · ${severity}`, EMBED_TITLE_MAX),
    color: badge.color,
    description: cap(descriptionParts.join("\n\n"), EMBED_DESCRIPTION_MAX),
    fields,
    footer: `${BULLETIN_HEADER_MARKER} · signature verified against the pinned publisher key`,
  };
  // Only set a link when verify.ts kept one (https, same origin as the index) and
  // it survived re-parsing here — see advisoryLink().
  if (advisoryUrl !== "") embed.url = advisoryUrl;

  // A backtick cannot be ESCAPED inside a code span — Discord closes the span at
  // the next one, whatever precedes it — so for this position the character is
  // removed rather than escaped.
  const content = `📢 **${BULLETIN_HEADER_MARKER}** — ${headline}: ${inlineCode(id)}`;

  // -- Telegram (plain text, no parse_mode: nothing parses it, nothing escapes) --
  // Built as blocks rather than one filtered line list: a blank separator line is
  // indistinguishable from an absent optional field once you filter empties, and
  // the header ran into the summary.
  //
  // OUR header is the only thing above the quote sigil. Everything the feed wrote
  // is below it, one `| ` line per field — and since feed strings are single-line
  // by the time they get here, none of them can start a line of their own.
  const header = [
    `${badge.emoji} ${BULLETIN_HEADER_MARKER} — ${headline}`,
    `${badge.label} · severity ${severity} · advisory "${quoteSafe(id)}"`,
  ];

  const quoted = [
    component !== "" ? `Component: ${component}` : "",
    published !== "" ? `Published: ${published}` : "",
    kind === "update" && modified !== "" && modified !== published ? `Updated: ${modified}` : "",
    summary,
  ]
    .filter((line) => line !== "")
    .map((line) => `${QUOTE_SIGIL}${line}`);

  const notes = [
    advisory.status === "open"
      ? "⚠️ Open advisory — deliberately non-actionable: no reproducer, no evidence, no target. Detail is published when the fix ships."
      : "",
    summary === "" ? "The advisory published no summary." : "",
    defanged ? DEFANG_NOTICE_TXT : "",
  ].filter((line) => line !== "");

  const tail = [
    advisoryUrl !== "" ? `Advisory: ${advisoryUrl}` : "",
    writeupUrl !== "" ? `Write-up and Q&A first in the insiders' channel: ${writeupUrl}` : "",
  ].filter((line) => line !== "");

  const telegramBlocks = [
    header.join("\n"),
    quoted.length > 0 ? `${QUOTE_HEADING}\n${quoted.join("\n")}` : "",
    notes.join("\n"),
    tail.join("\n"),
  ].filter((block) => block !== "");

  return {
    advisoryId: advisory.id,
    kind,
    discord: { content, embed },
    telegram: cap(telegramBlocks.join("\n\n"), TELEGRAM_MAX),
  };
}

/**
 * Does this advisory's own text imitate the bulletin's header? Returns a reason
 * for the log, or null when it is safe to render.
 *
 * Exported so ./index.ts can say WHY it refused: the renderer only says no.
 */
export function headerImpersonation(advisory: Advisory): string | null {
  for (const [field, raw] of feedFields(advisory)) {
    const text = neutralise(raw, MAX_SANITISE_LEN);
    if (text.toLowerCase().includes(BULLETIN_HEADER_MARKER.toLowerCase())) {
      return `${field} carries our own header phrase "${BULLETIN_HEADER_MARKER}"`;
    }
    for (const glyph of HEADER_GLYPHS) {
      if (text.includes(glyph)) return `${field} carries our own bulletin glyph ${glyph}`;
    }
  }
  return null;
}

/**
 * Every string in an advisory that came off the wire, named for the log line.
 *
 * The list is the contract this file is reviewed against: a field added to
 * {@link Advisory} and rendered but not listed here is a field nobody checked.
 * `status` is absent on purpose — it is not rendered, it is a key into
 * {@link STATUS_BADGE}, and a value outside that union never reaches a message.
 */
function feedFields(a: Advisory): [string, string][] {
  return [
    ["id", a.id],
    ["component", a.component],
    ["summary", a.summary],
    ["severity", a.severity],
    ["published", a.published],
    ["modified", a.modified],
    ["url", a.url],
  ];
}

/**
 * Full sanitation for one untrusted field. EVERY feed string goes through it.
 *
 * `prepareUntrusted` (AEGIS) does the dangerous half: NFKC so homoglyph tricks
 * collapse, C0/C1 control strip, zero-width and bidi-override strip, internal
 * marker neutralisation. Then:
 *
 *  - {@link flattenToOneLine} — an advisory field is one line by contract, and a
 *    field that cannot contain a line break cannot open a block that looks like a
 *    second bulletin header;
 *  - {@link defangMentions} — nothing that reads as a mass ping survives;
 *  - {@link defangLinks} — nothing that a client would linkify survives;
 *  - a cap with an ellipsis rather than a hard slice.
 *
 * De-fanging runs BEFORE the cap so the brackets it adds are counted against the
 * limit instead of overflowing it, and so a cut can only ever shorten text that is
 * already inert.
 */
export function neutralise(raw: string, max: number): string {
  return neutraliseTracked(raw, max).text;
}

/**
 * {@link neutralise}, plus whether de-fanging actually fired.
 *
 * The caller needs that fact and must not re-derive it by scanning the OUTPUT for `[.]`
 * markers: a payload whose only address had a punycode TLD produced no marker, so the
 * "deliberately not clickable" caveat was suppressed on exactly the post that most needed
 * it. Comparing before with after cannot be fooled by what the text happens to contain.
 */
export function neutraliseTracked(raw: string, max: number): { text: string; defanged: boolean } {
  const sanitised = prepareUntrusted(raw ?? "", MAX_SANITISE_LEN);
  const flattened = defangMentions(flattenToOneLine(sanitised));
  const defangedText = defangLinks(flattened);
  return {
    text: truncateChars(defangedText, max),
    defanged: isDefanged(flattened, defangedText),
  };
}

/** Room for a long summary before its own cap applies; well under any platform limit. */
const MAX_SANITISE_LEN = 4000;

/**
 * Every line break Unicode has. `prepareUntrusted` already strips C0/C1, so \v, \f
 * and NEL never reach us — they are listed anyway, because this guard must not
 * depend on the exact contents of another file's strip set. U+2028 and U+2029 are
 * the ones that genuinely survive it: printable-range separators that a client
 * still renders as a new line, and one of them is all a forged header needs.
 */
const LINE_BREAKS_RE = /[\r\n\u000B\u000C\u0085\u2028\u2029]+/gu;

/**
 * Collapse every line break and every whitespace run to a single space. An
 * advisory field is a one-liner by contract, and a field that cannot contain a
 * line break cannot open a block that reads as a second bulletin header.
 */
function flattenToOneLine(s: string): string {
  return s.replace(LINE_BREAKS_RE, " ").replace(/\s+/gu, " ").trim();
}

/**
 * De-fang anything that reads as a mention. The `@` is dropped rather than the
 * word: `@everyone` → `everyone` keeps the sentence readable, which matters when
 * the sentence is a security advisory. Channel/user/role tokens (`<@123>`,
 * `<#123>`, `<@&123>`) collapse to a marker, since their numeric payload carries
 * nothing a reader can use.
 */
export function defangMentions(s: string): string {
  return s
    .replace(/@(everyone|here)\b/gi, "$1")
    .replace(/<@[!&]?\d+>/g, "[mention removed]")
    .replace(/<#\d+>/g, "[channel removed]");
}

/** `scheme://` — the half of a url that both platforms need to see to linkify it. */
const SCHEME_RE = /([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\//g;

/**
 * A host-shaped run: one or more dotted labels ending in a TLD.
 *
 * The TLD alternation is the whole subtlety. Requiring LETTERS keeps version numbers
 * ("hub 3.2.1") and fractional-second timestamps ("09:00:00.123Z") out of the match —
 * and that is exactly how the first version of this guard shipped a live phishing link:
 * a punycode TLD contains digits and hyphens, so `momus-security.xn--p1ai` (.рф) sailed
 * through undefanged while `phishing.evil.com` was correctly bracketed. There are ~60
 * registrable `xn--` TLDs; each one was a hole. Telegram auto-links a scheme-less host
 * in plain text, and Telegram has no second layer — de-fanging IS the control there.
 *
 * So: an alphabetic TLD, OR an explicit `xn--` label. Spelling the punycode prefix out
 * rather than loosening the charset keeps version strings excluded — "3.2.1" still does
 * not match, because a numeric label is not `xn--`-prefixed.
 */
const HOST_RE =
  /(?<![\p{L}\p{N}])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+)(xn--[\p{L}\p{N}-]{1,59}|\p{L}{2,24})(?![\p{L}\p{N}-])/giu;

/**
 * De-fang every address-shaped run so NO client can turn feed text into a link.
 *
 * `https://phishing.evil.example/fix` → `https[:]//phishing[.]evil[.]example/fix`
 *
 * Both halves are needed. Killing only the scheme leaves `evil.example/fix`, which
 * Telegram happily linkifies on its own; killing only the dots leaves a scheme
 * that some clients treat as link enough. The result is the security industry's
 * ordinary de-fanged notation: still readable, still searchable, and reaching it
 * takes a deliberate edit rather than a tap.
 *
 * It over-matches slightly — "reference.The" becomes "reference[.]The" when a
 * space is missing after a full stop. That is the safe direction: a cosmetic
 * bracket in prose costs nothing, a live link in a security bulletin costs
 * everything.
 */
export function defangLinks(s: string): string {
  return s
    .replace(SCHEME_RE, "$1[:]//")
    .replace(HOST_RE, (_m, labels: string, tld: string) => `${labels.replaceAll(".", "[.]")}${tld}`);
}

/**
 * Did {@link defangLinks} actually change something? Drives the explanatory line.
 *
 * Compares before against after instead of sniffing the output for `[:]//` or `[.]`.
 * Sniffing was wrong in the direction that matters: a payload whose only address had a
 * punycode TLD and no other dotted token produced neither marker, so the "deliberately
 * not clickable" caveat was SUPPRESSED — the post looked entirely clean while carrying a
 * live link. A notice that disappears exactly when the text was most dangerous is worse
 * than no notice.
 */
function isDefanged(original: string, defanged: string): boolean {
  return original !== defanged;
}

const DEFANG_NOTICE_MD =
  "🔗 Addresses quoted from the advisory are shown de-fanged (`https[:]//`, `[.]`) and are " +
  "deliberately not clickable — the only link this bot publishes is the advisory link above.";
const DEFANG_NOTICE_TXT =
  "🔗 Addresses quoted from the advisory are shown de-fanged (https[:]// , [.]) and are " +
  "deliberately not clickable — the only links this bot publishes are its own, below.";

const QUOTE_HEADING = `Quoted from the MOMUS advisory — every "${QUOTE_SIGIL.trim()}" line below is the feed's own text:`;

/**
 * The advisory link, re-validated HERE.
 *
 * ./verify.ts origin-checks the link and then keeps the RAW string it checked —
 * and the WHATWG URL parser silently DROPS tabs and newlines before parsing, so
 * `https://ok.example/x\n\n🟢 …` passes an origin check and arrives with its line
 * breaks intact. Re-parsing and emitting the normalised form is what makes the one
 * live link in the post a single line by construction. https only, again: the
 * check that matters must not live in one file alone.
 */
function advisoryLink(raw: string): string {
  if (raw === "") return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  return url.toString();
}

/**
 * The insiders' write-up link, or "" when unconfigured.
 *
 * The base URL comes from config and the id is percent-encoded, so no part of
 * this URL is remote text. A feed-supplied link would be a redirect the community
 * would trust because our bot posted it.
 */
export function writeupLink(advisoryId: string, base?: string): string {
  const trimmed = (base ?? "").trim();
  if (trimmed === "") return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${path}${encodeURIComponent(advisoryId)}`;
  return url.toString();
}

/** Opening + closing fence and their newlines, budgeted before the summary is cut. */
const FENCE_OVERHEAD = 8;

/**
 * Wrap feed text in a Discord code fence: inside one, markdown is not parsed and
 * urls are not auto-linked, which is the whole point.
 *
 * A fence ends at the next ``` — so RUNS of backticks are replaced (one per
 * character, keeping the length and the shape) while a lone backtick is left
 * alone: it is inert inside a fence and advisories do quote `field_names`.
 */
function fence(s: string): string {
  return `\`\`\`\n${s.replace(/`{2,}/g, (run) => "'".repeat(run.length))}\n\`\`\``;
}

/**
 * Wrap feed text in an inline code span (embed field values, the content line).
 * Here EVERY backtick goes: a single one closes the span, and a backtick cannot be
 * escaped inside it — Discord closes at the next one whatever precedes it.
 */
function inlineCode(s: string): string {
  return `\`${cap(s.replaceAll("`", ""), EMBED_FIELD_VALUE_MAX - 2)}\``;
}

/**
 * Strip the quote characters we use to mark feed text on Telegram, so a value
 * cannot appear to close its own quotation and continue in our voice.
 */
function quoteSafe(s: string): string {
  return s.replaceAll('"', "'");
}

/** Hard cap with an ellipsis — the last line of defence before a platform limit. */
function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
