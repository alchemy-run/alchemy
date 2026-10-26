/**
 * True `alchemy dev` end-to-end: spawns the real CLI, which runs
 * SolidStart's own Vite dev server as the local `Website.Server` provider.
 * No Function, no storage account, and no Front Door are created; the only
 * cloud touch is the state store.
 *
 * SolidStart 2's dev SSR does not run under Bun (`srvx/node` writes
 * `[object Object]`), and the CLI runs on Bun. This suite asserts the local
 * URL identity and a `public/` file; the SSR and hot-reload checks need
 * `ALCHEMY_TEST_SOLIDSTART_DEV_SSR=1` (Node-hosted sidecar).
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DevCli, fetchOk } from "alchemy-test/DevCli";

const root = path.resolve(import.meta.dirname, "..");
// Isolated stage so this suite never fights integ.test.ts over state rows.
const STAGE = "dev-cli-test";
const cli = new DevCli({ root, stage: STAGE });
const runDevSsr = process.env.ALCHEMY_TEST_SOLIDSTART_DEV_SSR === "1";

const pagePath = path.join(root, "src", "routes", "index.tsx");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "Styled with Tailwind CSS";
const MARKER_V2 = "Styled with Tailwind CSS [dev-v2]";

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(pagePath, pageSource);
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 180_000);

let url = "";

test(
  "alchemy dev serves the SolidStart site locally",
  async () => {
    cli.start();
    url = await cli.outputUrlWhenReady("url", { tries: 180, delayMs: 1000 });

    // Dev identity: SolidStart's dev server, not Front Door or a Function.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("azurefd.net");
    expect(url).not.toContain("azurewebsites.net");

    // A public/ file serves through the dev server.
    expect(await (await fetchOk(new URL("/robots.txt", url))).text()).toContain("User-agent:");
  },
  { timeout: 600_000 },
);

test.skipIf(!runDevSsr)(
  "alchemy dev renders SSR with the site env and hot-reloads",
  async () => {
    // The GREETING from alchemy.run.ts reaches the dev server's process env.
    const home = await (await fetchOk(url)).text();
    expect(home).toContain("Hello from SolidStart on Azure!");

    // Vite's HMR serves the edited route without a deploy.
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
