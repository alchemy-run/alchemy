/**
 * True `alchemy dev` end-to-end: spawns the real CLI, which runs Astro's own
 * dev server as the local `Website.Server` provider. No Function, no storage
 * account, and no Front Door are created; the only cloud touch is the state
 * store.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DevCli, fetchOk } from "alchemy-test/DevCli";

const root = path.resolve(import.meta.dirname, "..");
// Isolated stage so this suite never fights integ.test.ts over state rows.
const STAGE = "dev-cli-test";
const cli = new DevCli({ root, stage: STAGE });

const pagePath = path.join(root, "src", "pages", "index.astro");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "server-rendered in an Azure Function";
const MARKER_V2 = "server-rendered in an Azure Function [dev-v2]";

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(pagePath, pageSource);
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 180_000);

test(
  "alchemy dev serves the Astro site locally with hot reload",
  async () => {
    cli.start();
    const url = await cli.outputUrlWhenReady("url", { tries: 180, delayMs: 1000 });

    // Dev identity: Astro's dev server, not Front Door or an Azure Function.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("azurefd.net");

    // The GREETING from alchemy.run.ts reaches the dev server.
    const home = await (await fetchOk(url)).text();
    expect(home).toContain("Hello from Astro on Azure!");
    expect(home).toContain(MARKER);
    const about = await fetchOk(new URL("/about/", url));
    expect(about.status).toBe(200);
    const robots = await (await fetchOk(new URL("/robots.txt", url))).text();
    expect(robots).toContain("User-agent:");

    // Astro serves the edited page without a deploy.
    fs.writeFileSync(pagePath, pageSource.replace(MARKER, MARKER_V2));
    await cli.pollUntil(
      "hot-reloaded page (v2 marker)",
      async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) return undefined;
          return (await res.text()).includes(MARKER_V2) ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { tries: 120, delayMs: 500 },
    );
  },
  { timeout: 600_000 },
);
