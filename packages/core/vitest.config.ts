import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    allowOnly: false,
    clearMocks: true,
    environment: "node",
    globals: false,
    hookTimeout: 5_000,
    include: ["src/**/*.test.ts"],
    mockReset: true,
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 5_000,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
