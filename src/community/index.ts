/**
 * COMMUNITY — one import for the insiders gate.
 *
 *   import { InsiderGate, InsiderStore, HttpGithubPublicReader } from "../community/index.js";
 *
 * The feature is three files and one role:
 *  - ./access.ts — the gate: challenge, contribution check, grant, forget.
 *  - ./store.ts  — the four fields we are allowed to remember about a person.
 *  - ./github.ts — the four PUBLIC routes we read, and no others.
 *
 * The channels and the `Insider` role itself are declared in
 * src/provision/structure.ts and applied by src/provision/discord.ts, so the
 * server layout stays in one place.
 */

export {
  InsiderGate,
  DEFAULT_CODE_TTL_MS,
  type AccessRefusal,
  type AccessRefusalCode,
  type ChallengeIssued,
  type ForgetResult,
  type InsiderGateOpts,
  type InsiderGranted,
  type InsiderRoleGranter,
} from "./access.js";
export {
  InsiderStore,
  INSIDER_BASES,
  INSIDER_FIELDS,
  type InsiderBasis,
  type InsiderRecord,
} from "./store.js";
export {
  HttpGithubPublicReader,
  type GistSummary,
  type GithubPublicReader,
  type HttpGithubPublicReaderOpts,
  type IssueComment,
  type IssueRef,
} from "./github.js";
