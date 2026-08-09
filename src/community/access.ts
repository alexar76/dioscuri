/**
 * COMMUNITY / access — the INSIDERS GATE.
 *
 * Two channels come out of MOMUS's bulletin, and they are not the same kind of
 * thing: #momus-bulletin is PUBLIC, and #momus-insiders is earned. This module
 * decides who gets into the second one, and it is written to make the wrong
 * versions of that decision structurally impossible.
 *
 * ── DECIDED, AND NOT UP FOR RE-LITIGATION ──────────────────────────────────────
 *
 * **The bulletin itself is PUBLIC.** A security bulletin's value is that affected
 * people read it. Gating advisories behind a loyalty test means somebody running
 * our code does not learn their component has an open hole. MOMUS's disclosure
 * design already makes `open` advisories non-actionable — no reproducer, no
 * evidence, no target URL — precisely so they CAN be public.
 *
 * **Exclusivity is TIMING and COMMENTARY, never information.** Insiders get the
 * write-up, the deep dive and the Q&A first. The advisory is public the moment it
 * is published.
 *
 * **The gate is CONTRIBUTION, never endorsement.** "Do this and get access" aimed
 * at an endorsement is incentivized engagement under GitHub's Acceptable Use
 * Policies, and a project whose whole positioning is auditability cannot afford
 * that. "Still endorses us" would be worse: it would mean polling individuals'
 * GitHub activity forever and keeping an engagement history — surveillance, plus a
 * data set we would then have to protect. Contribution selects for people who
 * GAVE something rather than people who clicked something.
 *
 * **No stars are read. Not once, not for a badge.** An earlier design granted a
 * cosmetic role on a single star check. It is gone: even a one-time read means the
 * bot asks "does this person endorse us", and a cosmetic role is exactly the sort
 * of thing that silently acquires permissions later. There is no star API call in
 * this feature, no star field in the store (see ./store.ts), no star word in a
 * grant reason, and no method on {@link GithubPublicReader} that could answer the
 * question (see ./github.ts). If somebody stars the project, nothing here
 * notices, records or rewards it.
 *
 * **Exactly ONE role.** `Insider`. Not a supporter tier, not a badge, not a
 * cosmetic rank — each additional role is a permission surface that drifts.
 *
 * **Data minimisation is a hard requirement.** discord_id, github_login,
 * granted_at, basis. Nothing else, ever. The shape lives in ./store.ts.
 *
 * ── PROVING A GITHUB ACCOUNT WITHOUT OAUTH ─────────────────────────────────────
 *
 * We never ask for a token. A token that can read somebody's activity is more
 * power than "I control this account" needs, and it would make us the custodian
 * of it. Instead, a public challenge:
 *
 *   1. the member runs a command naming their GitHub login; we mint a one-time
 *      code bound to their discord id, with a TTL;
 *   2. the member publishes that code under their own account — a public gist
 *      (description or filename) or a comment on ONE designated public issue;
 *   3. we read it through the public API and confirm the author's login is the
 *      login that was claimed.
 *
 * The code is NOT a secret — it has to be published, that is the point. It is safe
 * to publish because it is bound to a discord id AND to a claimed login: a
 * stranger who copies it out of the channel cannot redeem it (the redemption is
 * keyed on the discord id it was minted for), and cannot pass it off as their own
 * proof either (a proof must be authored by the login that asked for the code).
 * A code posted by the wrong account is refused loudly — see CODE_NOT_YOURS.
 *
 * ── EARNING THE ROLE ───────────────────────────────────────────────────────────
 *
 * Any ONE of:
 *  - a merged pull request in the org (public search);
 *  - an opened issue that has at least one MAINTAINER response. The maintainer
 *    response is the anti-farming clause: without it, the gate is "open an empty
 *    issue", which selects for noise and buries real reports;
 *  - a MOMUS finding of theirs that an operator marked CONFIRMED. This path runs
 *    through a human on purpose: MOMUS's report intake is anonymous by design, so
 *    there is NO automated link between an anonymous report and a person, and this
 *    module does not invent one. An operator names the Discord handle and takes
 *    responsibility; the audit trail records who did it.
 *
 * ── FAILURE PHILOSOPHY (nothing here throws) ───────────────────────────────────
 *
 * Modelled on src/provision/discord.ts and src/bulletin/index.ts for the same
 * reason: a member's command must not be able to take the bot down, and a GitHub
 * outage must read as "we could not check" rather than "you are not a
 * contributor". Every public method resolves with a discriminated result carrying
 * a machine-readable refusal code and one line of text fit to show a human.
 *
 * The one place we deliberately fail CLOSED is persistence: if the roster cannot
 * be written, the role is NOT granted. A role with no record behind it can be
 * neither explained nor forgotten, and both of those matter more than convenience.
 */

import { randomBytes } from "node:crypto";
import { INSIDER_ROLE } from "../provision/structure.js";
import { auditSafe } from "../shared/index.js";
import type { AuditLog, Logger } from "../types.js";
import type { GithubPublicReader, IssueRef } from "./github.js";
import { InsiderStore, type InsiderBasis, type InsiderRecord } from "./store.js";

/** How long a minted code stays redeemable. Long enough to write a gist, short enough to expire. */
export const DEFAULT_CODE_TTL_MS = 30 * 60 * 1000;

/** Human-recognisable, machine-findable, and obviously ours in a public comment. */
const CODE_PREFIX = "DIOSCURI-";
/** 8 bytes = 64 bits. Unguessable, even though it is not secret. */
const CODE_BYTES = 8;

/**
 * GitHub login rules: alphanumerics and single inner hyphens, 39 max. Validated
 * because the value lands in a URL path and in a search query — a login that is
 * not a login is a typo (or an injection attempt), not a person.
 */
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** Issues inspected for a maintainer response before we give up (bounds the API cost). */
const MAX_ISSUES_INSPECTED = 5;

/** Ceiling on outstanding challenges, so a flood of commands cannot grow memory. */
const MAX_PENDING_CHALLENGES = 500;

/**
 * Minimum spacing between redemption attempts by one member.
 *
 * One redeem costs up to nine PUBLIC GitHub requests (gist listing, the proof
 * issue, two searches, then a few issues' comments), and the command is available
 * to anybody in the server. Without this, one member holding the key down burns
 * the shared rate limit for everybody. The stamp lives ON the challenge, so it is
 * pruned with it and needs no second map to leak.
 */
const REDEEM_COOLDOWN_MS = 20_000;

/** Slack subtracted from the issue-comment `since` filter to absorb clock skew. */
const SINCE_SLACK_MS = 5 * 60 * 1000;

/**
 * GitHub's own author_association values that mean "someone on our side of the
 * project answered". Read from the public API; not a list we curate, so it cannot
 * quietly become a list of favourites.
 */
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type AccessRefusalCode =
  | "BAD_LOGIN"
  | "ALREADY_INSIDER"
  | "LOGIN_ALREADY_CLAIMED"
  | "BUSY"
  | "NO_CHALLENGE"
  | "EXPIRED"
  /** Redemption attempts are spaced out — see REDEEM_COOLDOWN_MS. */
  | "TOO_SOON"
  /** The proof we found carries a code minted for somebody else. */
  | "CODE_NOT_YOURS"
  /** Our code, published by an account other than the one claimed. */
  | "PROOF_AUTHOR_MISMATCH"
  | "PROOF_NOT_FOUND"
  | "NO_PROOF_CHANNEL"
  | "NO_CONTRIBUTION"
  | "GITHUB_UNAVAILABLE"
  | "NOT_OPERATOR"
  | "STORAGE_FAILED";

export interface AccessRefusal {
  ok: false;
  code: AccessRefusalCode;
  /** One line, safe to show a member. Never contains a secret or another person's data. */
  message: string;
}

export interface ChallengeIssued {
  ok: true;
  /**
   * The one-time code the member publishes. Meant to be public — see the header
   * for why that is safe. The platform edge should still answer privately
   * (ephemeral reply / DM), not because the code is a secret, but because a public
   * channel full of other people's verification codes is confusing noise.
   */
  code: string;
  /** Epoch ms after which the code is refused. */
  expiresAt: number;
  /** The login the code is bound to, as the member typed it. */
  githubLogin: string;
  message: string;
}

export interface InsiderGranted {
  ok: true;
  basis: InsiderBasis;
  record: InsiderRecord;
  /** The single role this feature grants. Kept in sync with the provisioner. */
  roleName: typeof INSIDER_ROLE;
  /** True when the member already held it and nothing was re-checked. */
  alreadyHeld: boolean;
  message: string;
}

export interface ForgetResult {
  ok: true;
  /** False when there was nothing to forget (already gone, or never granted). */
  deleted: boolean;
  message: string;
}

/**
 * The platform side of a grant. Optional: the roster is the source of truth, and
 * the Discord role is a projection of it, so a gate with no granter still works
 * (an operator or a reconciliation pass applies the roles).
 */
export interface InsiderRoleGranter {
  /** Add the `Insider` role to a member. May throw; the gate logs and continues. */
  grantRole(discordId: string): Promise<void>;
  /** Remove it again — used when somebody asks to be forgotten. */
  revokeRole?(discordId: string): Promise<void>;
}

export interface InsiderGateOpts {
  /** GitHub owner/org whose contributions count. Contributions elsewhere are somebody else's community. */
  owner: string;
  store: InsiderStore;
  github: GithubPublicReader;
  log: Logger;
  audit?: AuditLog;
  /**
   * The ONE public issue where a challenge code may be posted, e.g.
   * { repo: "aicom", number: 42 }. Omitted = only the gist route is available.
   */
  proofIssue?: { repo: string; number: number };
  /** Accept a public gist as proof (default true). */
  allowGistProof?: boolean;
  codeTtlMs?: number;
  now?: () => number;
  roleGranter?: InsiderRoleGranter;
}

interface PendingChallenge {
  discordId: string;
  /** The login as claimed; the proof must be authored by it. */
  githubLogin: string;
  code: string;
  issuedAt: number;
  expiresAt: number;
  /** Last redemption attempt (epoch ms), 0 = none yet. The flood valve. */
  lastAttemptAt: number;
}

/**
 * Outstanding challenges, in memory ONLY.
 *
 * Not persisted on purpose: a pending challenge is a discord id plus a claimed
 * login, i.e. data about a person that has not earned anything yet. A restart
 * forgetting it costs a member one command; persisting it would mean storing
 * people who never came back. Codes are single-use by deletion.
 */
class ChallengeRegistry {
  private readonly byDiscordId = new Map<string, PendingChallenge>();

  constructor(private readonly now: () => number) {}

  get size(): number {
    return this.byDiscordId.size;
  }

  prune(): void {
    const t = this.now();
    for (const [id, ch] of this.byDiscordId) {
      if (ch.expiresAt <= t) this.byDiscordId.delete(id);
    }
  }

  /** A fresh challenge REPLACES any earlier one for the same member. */
  put(ch: PendingChallenge): void {
    this.byDiscordId.set(ch.discordId, ch);
  }

  get(discordId: string): PendingChallenge | undefined {
    return this.byDiscordId.get(discordId);
  }

  delete(discordId: string): void {
    this.byDiscordId.delete(discordId);
  }

  /** Live (unexpired) codes belonging to somebody else — the CODE_NOT_YOURS check. */
  othersLiveCodes(discordId: string): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const ch of this.byDiscordId.values()) {
      if (ch.discordId === discordId) continue;
      if (ch.expiresAt <= t) continue;
      out.push(ch.code);
    }
    return out;
  }
}

export class InsiderGate {
  private readonly challenges: ChallengeRegistry;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly opts: InsiderGateOpts) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.codeTtlMs !== undefined && opts.codeTtlMs > 0 ? opts.codeTtlMs : DEFAULT_CODE_TTL_MS;
    this.challenges = new ChallengeRegistry(this.now);
  }

  /** The one role this feature knows how to grant. */
  get roleName(): typeof INSIDER_ROLE {
    return INSIDER_ROLE;
  }

  isInsider(discordId: string): boolean {
    return this.opts.store.has(discordId);
  }

  pendingChallenges(): number {
    this.challenges.prune();
    return this.challenges.size;
  }

  /**
   * Step 1: mint a one-time code bound to this discord id and claimed login.
   *
   * Synchronous and offline — no GitHub call happens until the member says the
   * proof is published, so a mistyped login costs nobody an API request.
   */
  startChallenge(input: { discordId: string; githubLogin: string }): ChallengeIssued | AccessRefusal {
    const discordId = input.discordId.trim();
    const githubLogin = input.githubLogin.trim();

    if (discordId === "") {
      return refuse("BAD_LOGIN", "I could not tell who is asking — try the command again.");
    }
    if (!GITHUB_LOGIN_RE.test(githubLogin)) {
      return refuse(
        "BAD_LOGIN",
        "That does not look like a GitHub username (letters, digits and single hyphens, up to 39 characters).",
      );
    }
    if (this.opts.store.has(discordId)) {
      return refuse(
        "ALREADY_INSIDER",
        "You already hold Insider. If the role is missing from your profile, ask a Keeper to re-apply it.",
      );
    }
    const claimed = this.opts.store.findByLogin(githubLogin);
    if (claimed !== undefined && claimed.discord_id !== discordId) {
      // Deliberately does not say WHO holds it: that would hand out a mapping
      // between a GitHub login and a Discord account to anyone who can guess.
      return refuse(
        "LOGIN_ALREADY_CLAIMED",
        "That GitHub account has already been used to claim Insider for a different Discord member.",
      );
    }
    if (!this.hasProofRoute()) {
      return refuse(
        "NO_PROOF_CHANNEL",
        "The gate is not fully configured yet — no public place to post a proof. A Keeper needs to set one.",
      );
    }

    this.challenges.prune();
    if (this.challenges.size >= MAX_PENDING_CHALLENGES && this.challenges.get(discordId) === undefined) {
      return refuse("BUSY", "Too many verifications in flight right now — try again in a few minutes.");
    }

    const issuedAt = this.now();
    const code = `${CODE_PREFIX}${randomBytes(CODE_BYTES).toString("hex").toUpperCase()}`;
    this.challenges.put({
      discordId,
      githubLogin,
      code,
      issuedAt,
      expiresAt: issuedAt + this.ttlMs,
      lastAttemptAt: 0,
    });

    const minutes = Math.round(this.ttlMs / 60_000);
    return {
      ok: true,
      code,
      expiresAt: issuedAt + this.ttlMs,
      githubLogin,
      message: [
        `Post this code publicly under the GitHub account \`${githubLogin}\`, then run the verify command again:`,
        code,
        this.proofInstructions(),
        `The code expires in ${minutes} minutes. It is not a secret — it only works for you.`,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  }

  /**
   * Step 2: read the public proof, then check for a contribution, then grant.
   *
   * Order matters. The proof comes first because a contribution check is a claim
   * about an ACCOUNT: checking it before we know the member controls that account
   * would let anybody claim any contributor's work.
   */
  async redeem(input: { discordId: string }): Promise<InsiderGranted | AccessRefusal> {
    const discordId = input.discordId.trim();
    const existing = this.opts.store.get(discordId);
    if (existing !== undefined) {
      // Idempotent and free: no GitHub call, no new audit entry, no second grant.
      return {
        ok: true,
        basis: existing.basis,
        record: existing,
        roleName: INSIDER_ROLE,
        alreadyHeld: true,
        message: "You already hold Insider — nothing to do.",
      };
    }

    const challenge = this.challenges.get(discordId);
    if (challenge === undefined) {
      return refuse("NO_CHALLENGE", "Start the verification first — I have no pending code for you.");
    }
    if (challenge.expiresAt <= this.now()) {
      // Dropped immediately: an expired code must not sit in memory waiting to be
      // confused for a live one.
      this.challenges.delete(discordId);
      return refuse("EXPIRED", "That code has expired. Start the verification again for a fresh one.");
    }
    // Flood valve BEFORE any GitHub call — that is the resource being protected.
    const sinceLast = this.now() - challenge.lastAttemptAt;
    if (challenge.lastAttemptAt !== 0 && sinceLast < REDEEM_COOLDOWN_MS) {
      return refuse(
        "TOO_SOON",
        `Give GitHub a moment — try again in ${Math.ceil((REDEEM_COOLDOWN_MS - sinceLast) / 1000)}s.`,
      );
    }
    challenge.lastAttemptAt = this.now();

    const proof = await this.findProof(challenge);
    if (!proof.ok) return proof;

    const contribution = await this.findContribution(proof.login);
    if (!contribution.ok) return contribution;

    // Single-use: the code is spent whether or not the grant below persists, so a
    // published code can never be replayed.
    this.challenges.delete(discordId);

    return this.grant({
      discordId,
      // The login GITHUB reported, not the string the member typed: canonical case,
      // and it is the account we actually verified.
      githubLogin: proof.login,
      basis: contribution.basis,
      actor: "pollux",
      auditData: { basis: contribution.basis, github_login: proof.login },
    });
  }

  /**
   * The operator path for a CONFIRMED MOMUS finding.
   *
   * MOMUS's intake is anonymous by design, so nothing automated can connect a
   * report to a Discord member — an operator does it and is named in the audit
   * trail. `operatorIsKeeper` must be stated explicitly by the caller (the
   * platform edge checks the Keeper role): a future edge that forgets the check
   * has to pass a literal lie to get through, which is easy to spot in review.
   *
   * `githubLogin` is optional here and stored as "" when absent — an anonymous
   * finder may have no account to name, and inventing one would be a fiction in
   * the roster.
   */
  async grantForConfirmedFinding(input: {
    discordId: string;
    githubLogin?: string;
    operatorKey: string;
    operatorIsKeeper: boolean;
    /** MOMUS advisory/lead id. Audit only — it never enters the roster. */
    lead?: string;
  }): Promise<InsiderGranted | AccessRefusal> {
    if (!input.operatorIsKeeper) {
      return refuse("NOT_OPERATOR", "Only a Keeper can confirm a MOMUS finding for a member.");
    }
    const discordId = input.discordId.trim();
    if (discordId === "") {
      return refuse("BAD_LOGIN", "Name the Discord member to grant Insider to.");
    }
    const login = (input.githubLogin ?? "").trim();
    if (login !== "" && !GITHUB_LOGIN_RE.test(login)) {
      return refuse("BAD_LOGIN", "That does not look like a GitHub username. Leave it out if the finder is anonymous.");
    }
    const existing = this.opts.store.get(discordId);
    if (existing !== undefined) {
      return {
        ok: true,
        basis: existing.basis,
        record: existing,
        roleName: INSIDER_ROLE,
        alreadyHeld: true,
        message: "That member already holds Insider.",
      };
    }
    if (login !== "") {
      const claimed = this.opts.store.findByLogin(login);
      if (claimed !== undefined && claimed.discord_id !== discordId) {
        return refuse(
          "LOGIN_ALREADY_CLAIMED",
          "That GitHub account has already been used to claim Insider for a different Discord member.",
        );
      }
    }
    return this.grant({
      discordId,
      githubLogin: login,
      basis: "finding",
      actor: input.operatorKey,
      auditData: {
        basis: "finding",
        github_login: login,
        // The operator's justification. About a finding, never about a person.
        ...(input.lead !== undefined && input.lead !== "" ? { lead: input.lead.slice(0, 120) } : {}),
      },
    });
  }

  /**
   * A person asks to be forgotten (or an operator revokes access): the row is
   * DELETED and the role removed. Deleting the row while leaving the role would
   * mean access we can no longer explain; removing the role while keeping the row
   * would mean remembering somebody who asked us not to.
   */
  async forget(input: {
    discordId: string;
    /** Who asked — the member themselves, or an operator. Audit only. */
    actor?: string;
  }): Promise<ForgetResult | AccessRefusal> {
    const discordId = input.discordId.trim();
    let deleted: boolean;
    try {
      deleted = await this.opts.store.forget(discordId);
    } catch (err) {
      this.opts.log.error("could not delete an insider row — the roster still holds it", {
        error: err instanceof Error ? err.message : String(err),
      });
      return refuse(
        "STORAGE_FAILED",
        "I could not complete the removal right now. A Keeper has been asked to finish it by hand.",
      );
    }

    // Best-effort role removal. A stale role with no row is visible to moderators
    // and fixable; a failed revoke must not resurrect the row we just deleted.
    const revoke = this.opts.roleGranter?.revokeRole;
    if (revoke !== undefined) {
      try {
        await revoke.call(this.opts.roleGranter, discordId);
      } catch (err) {
        this.opts.log.warn("insider role revoke failed — the roster row is already gone", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.challenges.delete(discordId);

    if (deleted) {
      await auditSafe(
        this.opts.audit,
        {
          ts: new Date(this.now()).toISOString(),
          platform: "discord",
          kind: "insiders.forget",
          actor: input.actor ?? "self",
          subject: `dc:${discordId}`,
          data: {},
        },
        this.opts.log,
      );
    }
    return {
      ok: true,
      deleted,
      message: deleted
        ? "Done — your row is deleted and the role removed. Nothing about you is kept."
        : "There was nothing stored about you.",
    };
  }

  // -- internals ---------------------------------------------------------------

  private hasProofRoute(): boolean {
    if (this.opts.allowGistProof !== false) return true;
    return this.opts.proofIssue !== undefined;
  }

  private proofInstructions(): string {
    const lines: string[] = [];
    if (this.opts.allowGistProof !== false) {
      lines.push("• a PUBLIC gist with the code in its description or filename, or");
    }
    const issue = this.opts.proofIssue;
    if (issue !== undefined) {
      lines.push(
        `• a comment containing the code on the verification issue ${this.opts.owner}/${issue.repo}#${issue.number}.`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Look for the code in the public places we accept, and confirm WHO published
   * it. Reads only: gist listings (description + filenames) and the comments of
   * one designated issue, narrowed to comments newer than the challenge.
   */
  private async findProof(
    challenge: PendingChallenge,
  ): Promise<{ ok: true; login: string } | AccessRefusal> {
    const wanted = challenge.code.toUpperCase();
    const others = this.challenges.othersLiveCodes(challenge.discordId).map((c) => c.toUpperCase());
    /** Somebody else's live code turned up in what we read — a replay attempt. */
    let sawSomeoneElsesCode = false;
    /** Our own code turned up, but under an account that is not the claimed one. */
    let sawWrongAuthor = false;

    /** Returns true on our code; records (but does not accept) a foreign one. */
    const inspect = (text: string): boolean => {
      const haystack = text.toUpperCase();
      if (haystack.includes(wanted)) return true;
      if (others.some((c) => haystack.includes(c))) sawSomeoneElsesCode = true;
      return false;
    };

    if (this.opts.allowGistProof !== false) {
      try {
        const gists = await this.opts.github.listPublicGists(challenge.githubLogin);
        for (const gist of gists) {
          if (!gist.isPublic) continue; // a private gist is not a public proof
          if (!inspect([gist.description, ...gist.filenames].join("\n"))) continue;
          // The listing came from the claimed login's own gist collection, so the
          // owner IS that account — that is what makes this a proof of control.
          // The owner login is re-checked anyway (a rename + redirect would return
          // somebody else's collection, and that is not the account we asked for).
          if (gist.ownerLogin !== "" && gist.ownerLogin.toLowerCase() !== challenge.githubLogin.toLowerCase()) {
            sawWrongAuthor = true;
            continue;
          }
          // Prefer GitHub's own casing over what the member typed.
          return { ok: true, login: gist.ownerLogin !== "" ? gist.ownerLogin : challenge.githubLogin };
        }
      } catch (err) {
        return this.githubUnavailable("gist proof", err);
      }
    }

    const issue = this.opts.proofIssue;
    if (issue !== undefined) {
      try {
        const since = new Date(challenge.issuedAt - SINCE_SLACK_MS).toISOString();
        const comments = await this.opts.github.listIssueComments({
          owner: this.opts.owner,
          repo: issue.repo,
          issueNumber: issue.number,
          since,
        });
        for (const comment of comments) {
          const isClaimed = comment.authorLogin.toLowerCase() === challenge.githubLogin.toLowerCase();
          if (!inspect(comment.body)) continue;
          if (!isClaimed) {
            // Our code, published by a DIFFERENT account. Control of the account
            // is the entire thing being proved, so this proves nothing. The other
            // login is NOT echoed back: that would hand out a GitHub↔Discord
            // mapping to whoever asked.
            this.opts.log.warn("challenge code found under an account that did not request it", {
              claimed: challenge.githubLogin,
            });
            sawWrongAuthor = true;
            continue;
          }
          // The login comes from the comment payload, in GitHub's own casing.
          return { ok: true, login: comment.authorLogin };
        }
      } catch (err) {
        return this.githubUnavailable("issue-comment proof", err);
      }
    }

    if (sawWrongAuthor) {
      return refuse(
        "PROOF_AUTHOR_MISMATCH",
        "I found your code, but it was published by a different GitHub account than the one you named. " +
          "Post it under that account, or start again with the right username.",
      );
    }
    if (sawSomeoneElsesCode) {
      return refuse(
        "CODE_NOT_YOURS",
        "That code was issued to a different member. Run the verify command yourself to get your own code.",
      );
    }
    return refuse(
      "PROOF_NOT_FOUND",
      ["I could not find your code published under that account yet.", this.proofInstructions()]
        .filter((l) => l !== "")
        .join("\n"),
    );
  }

  /**
   * Contribution, any ONE of: a merged pull request, or an opened issue with a
   * maintainer response. The merged-PR search runs first — it is one request and
   * settles most cases.
   *
   * Nothing in here reads endorsements: the two searches are the whole check.
   */
  private async findContribution(login: string): Promise<{ ok: true; basis: InsiderBasis } | AccessRefusal> {
    try {
      const merged = await this.opts.github.searchMergedPullRequests({ owner: this.opts.owner, login });
      if (merged.length > 0) return { ok: true, basis: "pr" };
    } catch (err) {
      return this.githubUnavailable("merged pull request search", err);
    }

    let issues: IssueRef[];
    try {
      issues = await this.opts.github.searchAuthoredIssues({ owner: this.opts.owner, login });
    } catch (err) {
      return this.githubUnavailable("issue search", err);
    }

    for (const issue of issues.slice(0, MAX_ISSUES_INSPECTED)) {
      if (issue.repo === "") continue;
      let comments;
      try {
        comments = await this.opts.github.listIssueComments({
          owner: this.opts.owner,
          repo: issue.repo,
          issueNumber: issue.number,
        });
      } catch (err) {
        // One unreadable issue is not a verdict on the member; try the next.
        this.opts.log.warn("could not read comments while checking an issue — skipping it", {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const answered = comments.some(
        (c) =>
          MAINTAINER_ASSOCIATIONS.has(c.authorAssociation.toUpperCase()) &&
          c.authorLogin.toLowerCase() !== login.toLowerCase(),
      );
      if (answered) return { ok: true, basis: "issue" };
    }

    // An empty issue nobody answered is not a contribution. Said plainly, because
    // "no" without a reason reads as a broken bot.
    return refuse(
      "NO_CONTRIBUTION",
      [
        "Verified the account, but I found no qualifying contribution yet. Insider is earned by one of:",
        "• a merged pull request in the org,",
        "• an issue you opened that a maintainer replied to,",
        "• a MOMUS finding of yours confirmed by an operator (ask a Keeper).",
      ].join("\n"),
    );
  }

  /** Persist first, then project onto Discord. See the header for why that order. */
  private async grant(input: {
    discordId: string;
    githubLogin: string;
    basis: InsiderBasis;
    actor: string;
    auditData: Record<string, unknown>;
  }): Promise<InsiderGranted | AccessRefusal> {
    const record: InsiderRecord = {
      discord_id: input.discordId,
      github_login: input.githubLogin,
      granted_at: new Date(this.now()).toISOString(),
      basis: input.basis,
    };
    try {
      await this.opts.store.grant(record);
    } catch (err) {
      // FAIL CLOSED: no row, no role. A role we cannot account for is worse than a
      // member waiting for a retry.
      this.opts.log.error("insider roster write failed — access NOT granted", {
        error: err instanceof Error ? err.message : String(err),
      });
      return refuse(
        "STORAGE_FAILED",
        "I could not record the grant, so I have not applied the role. Try again shortly.",
      );
    }

    const granter = this.opts.roleGranter;
    if (granter !== undefined) {
      try {
        await granter.grantRole(input.discordId);
      } catch (err) {
        // The row is the entitlement; a missing role is self-healing on the next
        // reconciliation, so this is a warning and not a rollback.
        this.opts.log.warn("insider role add failed — the grant is recorded and can be re-applied", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await auditSafe(
      this.opts.audit,
      {
        ts: record.granted_at,
        platform: "discord",
        kind: "insiders.grant",
        actor: input.actor,
        subject: `dc:${input.discordId}`,
        // Exactly the facts of the grant. No evidence copy, no URLs, no activity:
        // the contribution is public on GitHub and re-checkable by anyone.
        data: input.auditData,
      },
      this.opts.log,
    );
    this.opts.log.info("insider access granted", { basis: input.basis });

    return {
      ok: true,
      basis: input.basis,
      record,
      roleName: INSIDER_ROLE,
      alreadyHeld: false,
      message: `Welcome in — Insider granted (${reasonText(input.basis)}). The advisories themselves stay public in #momus-bulletin.`,
    };
  }

  private githubUnavailable(what: string, err: unknown): AccessRefusal {
    this.opts.log.warn(`GitHub read failed (${what}) — refusing rather than guessing`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return refuse(
      "GITHUB_UNAVAILABLE",
      "I could not reach GitHub to check that just now. Nothing is held against you — try again in a few minutes.",
    );
  }
}

function refuse(code: AccessRefusalCode, message: string): AccessRefusal {
  return { ok: false, code, message };
}

/**
 * Human wording for a basis. There is no wording for an endorsement, because
 * there is no basis for one.
 */
function reasonText(basis: InsiderBasis): string {
  switch (basis) {
    case "pr":
      return "merged pull request";
    case "issue":
      return "issue answered by a maintainer";
    case "finding":
      return "confirmed MOMUS finding";
  }
}
