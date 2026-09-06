import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type SignalHeroEvent,
  SignalHeroPublisher,
  renderSignalHero,
  verifyHeroFeed,
} from "../src/signal-hunt/heroes.js";
import type { Logger } from "../src/types.js";

const keys = generateKeyPairSync("ed25519");
const spki = keys.publicKey.export({ format: "der", type: "spki" });
const publicKeyB64 = spki.subarray(spki.length - 32).toString("base64");

function hero(id = "hero_123", handle = "nova-7"): SignalHeroEvent {
  return {
    id,
    schema: "aicom.signal-hunt.hero.v1",
    created_at: new Date().toISOString(),
    handle,
    event_type: "promotion",
    status: "void_navigator",
    score: 4200,
    rounds: 7,
    correct: 6,
    best_streak: 4,
    rewards: ["tier:void_navigator"],
    url: "https://hunt.modelmarket.dev/#heroes",
  };
}

function signedFeed(handle = "nova-7", events: SignalHeroEvent[] = [hero("hero_123", handle)]) {
  const payload = {
    schema: "aicom.signal-hunt.heroes.v1",
    generated_at: new Date().toISOString(),
    source: "https://hunt.modelmarket.dev",
    events,
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    schema: "aicom.signal-hunt.signed-feed.v1",
    payload,
    signed_payload_b64: bytes.toString("base64url"),
    signature: {
      algorithm: "ed25519",
      public_key: publicKeyB64,
      value: sign(null, bytes, keys.privateKey).toString("base64"),
    },
  };
}

describe("Signal Hunt signed hero feed", () => {
  it("accepts the pinned Ed25519 feed and renders a proof-labelled announcement", () => {
    const feed = verifyHeroFeed(signedFeed(), publicKeyB64);
    expect(feed.events).toHaveLength(1);
    const text = renderSignalHero(feed.events[0]!, "https://hunt.modelmarket.dev");
    expect(text).toContain("nova-7");
    expect(text).toContain("4200 verified points");
    expect(text).toContain("signed Signal Hunt feed");
  });

  it("refuses tampering, wrong pins and mass mentions", () => {
    const tampered = signedFeed("@everyone");
    tampered.signed_payload_b64 = Buffer.from(
      Buffer.from(tampered.signed_payload_b64, "base64url").toString().replace("4200", "9999"),
    ).toString("base64url");
    expect(() => verifyHeroFeed(tampered, publicKeyB64)).toThrow("signature invalid");
    expect(() => verifyHeroFeed(signedFeed(), Buffer.alloc(32, 7).toString("base64"))).toThrow(
      "does not match operator pin",
    );
    const clean = verifyHeroFeed(signedFeed("@everyone"), publicKeyB64);
    expect(clean.events[0]!.handle).not.toContain("@everyone");
  });

  it("records a baseline and retries one failed sink without duplicating the other", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dioscuri-heroes-"));
    let document = signedFeed("nova-7", [hero("hero_existing")]);
    const discordPosts: string[] = [];
    const xPosts: string[] = [];
    let failX = true;
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => logger,
    };
    const publisher = new SignalHeroPublisher({
      feedUrl: "https://hunt.modelmarket.dev/api/v1/heroes/feed",
      publicKeyB64,
      pageUrl: "https://hunt.modelmarket.dev/#heroes",
      pollIntervalMin: 5,
      maxPostsPerRun: 4,
      dataDir,
      log: logger,
      fetchFn: async () => Response.json(document),
      sinks: [
        { name: "discord", post: async (event) => { discordPosts.push(event.id); } },
        {
          name: "x",
          post: async (event) => {
            xPosts.push(event.id);
            if (failX) throw new Error("temporary X outage");
          },
        },
      ],
    });
    try {
      await publisher.pollOnce();
      expect(discordPosts).toEqual([]);
      expect(xPosts).toEqual([]);

      document = signedFeed("nova-7", [hero("hero_new"), hero("hero_existing")]);
      await publisher.pollOnce();
      expect(discordPosts).toEqual(["hero_new"]);
      expect(xPosts).toEqual(["hero_new"]);

      failX = false;
      await publisher.pollOnce();
      expect(discordPosts).toEqual(["hero_new"]);
      expect(xPosts).toEqual(["hero_new", "hero_new"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
