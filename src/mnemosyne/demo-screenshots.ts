/**
 * Demo URL eligibility for screenshot capture — skip broken, duplicate, or
 * non-visual URLs before we spend Playwright time or spam Telegram.
 */

const BLOCKED = [
  /\*\*/,
  /crates\.io/i,
  /\/install\/?$/i,
  /\/api\//i,
  /\/admin\/?$/i,
  /bit\.ly/i,
];

/** URLs that should never be screenshotted (WebGL shells, broken headless renders). */
const SCREENSHOT_BLOCKLIST = [
  /oracles\.modelmarket\.dev\/platon\/umbral/i,
  /\/umbral\/?$/i,
];

/** Hosts that often return dark WIP shells with little visible content. */
const LOW_TRUST = [/modeldev\.modelmarket\.dev/i];

export function isEligibleDemoScreenshotUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (BLOCKED.some((re) => re.test(url))) return false;
  if (SCREENSHOT_BLOCKLIST.some((re) => re.test(url))) return false;
  return true;
}

/** Higher score = prefer for limited screenshot slots (Telegram album cap). */
export function demoScreenshotScore(url: string): number {
  if (!isEligibleDemoScreenshotUrl(url)) return -1;
  let score = 0;
  if (/magic-ai-factory\.com/i.test(url)) score += 40;
  if (/modelmarket\.dev/i.test(url)) score += 8;
  if (/github\.io/i.test(url)) score += 5;
  if (/oracles\.modelmarket\.dev/i.test(url)) score -= 40;
  if (LOW_TRUST.some((re) => re.test(url))) score -= 30;
  const slashes = (url.match(/\//g) ?? []).length;
  if (slashes >= 2 && slashes <= 5) score += 4;
  return score;
}

export function pickDemoScreenshotTargets(
  entries: readonly { repo: string; url: string }[],
  max: number,
): { repo: string; url: string }[] {
  const seen = new Set<string>();
  const ranked = entries
    .filter((e) => isEligibleDemoScreenshotUrl(e.url))
    .filter((e) => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    })
    .sort((a, b) => demoScreenshotScore(b.url) - demoScreenshotScore(a.url));
  return ranked.slice(0, max);
}
