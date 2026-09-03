import { defineConfig } from "@playwright/test";

/**
 * The org UI's end-to-end suite. Two projects:
 *
 * - `ui` — the SPA against a FAKE backend (`ui/harness.ts` answers
 *   every `/api` call and both sockets in-page) with a fixed clock, so
 *   aria snapshots are byte-stable. This is the UX contract: what a
 *   pull request looks like, what the tab strip offers, what survives
 *   a reload. Runs anywhere `vite` runs — no credentials, no cloud.
 *
 * - `live` (opt-in: `E2E_LIVE=1`) — the same SPA against a running
 *   `alchemy dev` stack (workspace sandbox, real GitHub). Proves the
 *   wiring the fake can't: real PR data, a real shell behind the
 *   terminal socket, sessions that exist server-side after a reload.
 *
 * - `shots` — the screenshot GALLERY (`ui/gallery.shots.ts`): a pixel
 *   snapshot per feature state, committed under `ui/__screenshots__/`
 *   so the UX can be SEEN in review, not just diffed as an aria tree.
 *
 *     pnpm test:e2e           # ui + shots
 *     pnpm test:e2e:update    # re-bless the UX after a deliberate change
 *     pnpm test:e2e:live      # + live (reuses a running `bun run dev`)
 */
const PACKAGE_ROOT = `${import.meta.dirname}/..`;
const UI_PORT = 4173;
const LIVE_URL = process.env.E2E_URL ?? "http://localhost:1337";
const live = process.env.E2E_LIVE !== undefined;
// pixel baselines are platform-bound: on CI only where they were blessed
const shots =
  !process.env.CI ||
  process.env.E2E_SHOTS !== undefined ||
  process.platform === "darwin";

export default defineConfig({
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  maxFailures: process.env.CI ? 5 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFileName}/{arg}{ext}",
  use: {
    browserName: "chromium",
    colorScheme: "dark",
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "ui",
      testDir: "./ui",
      testMatch: /.*\.e2e\.ts/,
      use: { baseURL: `http://localhost:${UI_PORT}` },
    },
    ...(shots
      ? [
          {
            // the GALLERY: one pixel snapshot per feature state, against
            // the same fake. Baselines are per platform (font rasterizing
            // differs), so they live under `ui/__screenshots__/*-darwin.png`
            // etc. and are only enforced where a baseline exists.
            name: "shots",
            testDir: "./ui",
            testMatch: /.*\.shots\.ts/,
            snapshotPathTemplate:
              "{testDir}/__screenshots__/{arg}{-snapshotSuffix}{ext}",
            use: {
              baseURL: `http://localhost:${UI_PORT}`,
              viewport: { width: 1440, height: 1000 },
            },
            expect: {
              toHaveScreenshot: {
                // the terminal's blinking caret and sub-pixel text edges
                maxDiffPixelRatio: 0.01,
                animations: "disabled" as const,
                caret: "hide" as const,
              },
            },
          },
        ]
      : []),
    ...(live
      ? [
          {
            name: "live",
            testDir: "./live",
            testMatch: /.*\.e2e\.ts/,
            // one machine, one directory — serialize so sessions the
            // tests create and delete never interleave
            fullyParallel: false,
            workers: 1,
            timeout: 180_000,
            use: { baseURL: LIVE_URL },
          },
        ]
      : []),
  ],
  webServer: [
    {
      // the SPA alone; every request the `ui` project would send to
      // the backend is intercepted in-page before it reaches vite
      command: `pnpm exec vite ui --port ${UI_PORT} --strictPort`,
      cwd: PACKAGE_ROOT,
      url: `http://localhost:${UI_PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    ...(live
      ? [
          {
            command: "bun run dev",
            cwd: PACKAGE_ROOT,
            url: LIVE_URL,
            reuseExistingServer: true,
            timeout: 600_000,
          },
        ]
      : []),
  ],
});
