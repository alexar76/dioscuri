/** Live readiness for THEOROS (canon column) — surfaced on GET /health. */

export interface TheorosStatus {
  /** All gates pass: Discord up, #the-canon wired, canon slot, theoros in KB. */
  active: boolean;
  discord: boolean;
  canonChannel: boolean;
  slot: boolean;
  kb: boolean;
}

export function computeTheorosStatus(opts: {
  discordReady: boolean;
  canonChannelId: string;
  githubRepos: readonly string[];
  slots: readonly { kind: string }[];
}): TheorosStatus {
  const canonChannel = Boolean(opts.canonChannelId.trim());
  const slot = opts.slots.some((s) => s.kind === "canon");
  const kb = opts.githubRepos.some((r) => r === "theoros" || r.endsWith("/theoros"));
  const discord = opts.discordReady;
  return {
    active: discord && canonChannel && slot && kb,
    discord,
    canonChannel,
    slot,
    kb,
  };
}
