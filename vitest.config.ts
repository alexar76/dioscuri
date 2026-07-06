import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Deterministic order keeps hash-chain / rate-limit tests stable.
    sequence: { shuffle: false },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/adapters/**"],
    },
  },
});
