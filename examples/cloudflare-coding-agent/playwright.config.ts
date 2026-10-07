import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against a running stack: `alchemy dev` (started for you,
 * or reused when already running) or a deployment (`WEB_URL` + `API_URL`).
 *
 *   GITHUB_TOKEN=$(gh auth token) doppler run -- pnpm test:e2e
 */
const WEB_URL = process.env.WEB_URL ?? "http://localhost:1337";

export default defineConfig({
  testDir: "./e2e",
  // A session's first turn prepares its workspace and runs a model.
  timeout: 5 * 60_000,
  expect: { timeout: 3 * 60_000 },
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
  },
  webServer: process.env.WEB_URL
    ? undefined
    : {
        command: "alchemy dev",
        url: WEB_URL,
        reuseExistingServer: true,
        timeout: 10 * 60_000,
        stdout: "pipe",
      },
});
