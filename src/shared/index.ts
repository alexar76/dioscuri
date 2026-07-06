/**
 * Shared utilities — single import for all common helpers.
 *
 *   import { truncateChars, normalizeLink, INVITE_RE, auditSafe } from "../shared/index.js";
 */

export { auditSafe } from "./audit.js";
export {
  collapseWhitespace,
  graphemes,
  INVITE_RE,
  LINK_RE,
  normalizeLink,
  stripForeignInvites,
  truncateChars,
  truncateGraphemes,
} from "./text.js";
