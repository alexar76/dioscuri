/**
 * Shared utilities — single import for all common helpers.
 *
 *   import { truncateChars, normalizeLink, INVITE_RE, auditSafe } from "../shared/index.js";
 */

export { auditSafe } from "./audit.js";
export {
  collapseWhitespace,
  firstSentence,
  graphemes,
  INVITE_RE,
  LINK_RE,
  normalizeLink,
  releaseBlurb,
  stripForeignInvites,
  stripMarkdown,
  truncateChars,
  truncateGraphemes,
} from "./text.js";
