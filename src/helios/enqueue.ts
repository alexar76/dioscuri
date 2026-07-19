/**
 * HELIOS syndication hook — append release job to shared queue (fail-soft).
 *
 * Charter: DIOSCURI never holds YouTube OAuth; it only enqueues a job descriptor.
 * Enabled when HELIOS_SYNDICATION=1 and HELIOS_QUEUE_PATH points at a jsonl file.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Logger, ReleaseEvent } from "../types.js";

export interface HeliosEnqueueOpts {
  log: Logger;
  queuePath: string;
}

export function isHeliosSyndicationEnabled(): boolean {
  return process.env.HELIOS_SYNDICATION === "1" && Boolean(process.env.HELIOS_QUEUE_PATH?.trim());
}

export function enqueueReleaseVideo(ev: ReleaseEvent, opts: HeliosEnqueueOpts): void {
  const path = opts.queuePath.trim();
  if (!path) return;

  const job = {
    template: "release-short",
    vars: {
      repo: ev.repo.split("/").pop() ?? ev.repo,
      tag: ev.tag,
      url: ev.url,
      summary: ev.summary.slice(0, 500),
    },
    youtube: {
      title: `${ev.repo.split("/").pop() ?? ev.repo} ${ev.tag} shipped`.slice(0, 100),
      description: `${ev.summary}\n\n${ev.url}`.slice(0, 4000),
      tags: ["AIAgents", "OpenSource"],
      privacy: "private",
    },
    idempotency_key: `release:${ev.repo}:${ev.tag}`,
    source: "dioscuri",
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(job) + "\n", { encoding: "utf-8", mode: 0o600 });
    opts.log.info("HELIOS job enqueued", { repo: ev.repo, tag: ev.tag });
  } catch (err) {
    opts.log.warn("HELIOS enqueue failed (fail-soft)", { err: String(err) });
  }
}
