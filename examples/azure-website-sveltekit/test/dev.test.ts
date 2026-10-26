/**
 * True `alchemy dev` end-to-end: spawns the real CLI, which runs SvelteKit's
 * own Vite dev server as the local `Website.Server` provider. No Function,
 * no storage account, and no Front Door are created; the only cloud touch
 * is the state store.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DevCli, fetchOk } from "alchemy-test/DevCli";

const root = path.resolve(import.meta.dirname, "..");
// Isolated stage so this suite never fights integ.test.ts over state rows.
const STAGE = "dev-cli-test";
const cli = new DevCli({ root, stage: STAGE });

const pagePath = path.join(root, "src", "routes", "+page.svelte");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "SvelteKit on Azure";
const MARKER_V2 = "SvelteKit on Azure [dev-v2]";

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(pagePath, pageSource);
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 180_000);

test(
  "alchemy dev serves the SvelteKit site locally with hot reload",
  async () => {
    cli.start();
    const url = await cli.outputUrlWhenReady("url", { tries: 180, delayMs: 1000 });

    // Dev identity: kit's dev server, not Front Door or a Function.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("azurefd.net");
    expect(url).not.toContain("azurewebsites.net");

    // The GREETING from alchemy.run.ts reaches the dev server's process env.
    const home = await (await fetchOk(url)).text();
    expect(home).toContain("Hello from SvelteKit on Azure!");
    expect(home).toContain(MARKER);

    // The prerendered route and a static/ file serve through the dev server.
    expect((await fetchOk(new URL("/about", url))).status).toBe(200);
    expect(await (await fetchOk(new URL("/robots.txt", url))).text()).toContain("User-agent:");

    // Vite's HMR serves the edited page without a deploy.
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
