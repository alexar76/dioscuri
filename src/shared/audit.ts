/**
 * Shared audit helper — best-effort append to the tamper-evident audit log.
 * A broken audit sink must never break the caller; failures are logged and
 * swallowed.
 */

import type { AuditEvent, AuditLog, Logger } from "../types.js";

/**
 * Append one event to the audit chain.  Never throws — a broken audit sink
 * must not break the caller (content delivery, moderation, promo, etc.).
 */
export async function auditSafe(
  audit: AuditLog | undefined,
  ev: AuditEvent,
  log: Logger,
): Promise<void> {
  if (!audit) return;
  try {
    await audit.append(ev);
  } catch (err) {
    log.warn("audit append failed", {
      kind: ev.kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
