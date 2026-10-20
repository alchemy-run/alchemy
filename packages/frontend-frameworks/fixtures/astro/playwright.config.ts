import { defineConfig } from "@playwright/test";

export default defineConfig({
  tsconfig: "../tsconfig.playwright.json",
  testDir: "./test",
  // Windows CI runs every fixture e2e concurrently; absorb runner flakiness.
  retries: process.env.CI ? 2 : 0,
  // A systemic failure (runner capacity, broken build) otherwise burns
  // retries x timeout on every remaining spec — fail the suite fast.
  maxFailures: process.env.CI ? 5 : 0,
  timeout: 60_000,
  build: {
    // distilled is a prebuilt dependency linked from submodules/, outside
    // node_modules: keep playwright's require hook (which rewrites specifiers
    // to raw paths, breaking require(esm) on Windows) away from it.
    external: ["**/submodules/distilled/**"],
  },
  expect: {
    timeout: 10_000,
  },
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        colorScheme: "light",
        deviceScaleFactor: 1,
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
