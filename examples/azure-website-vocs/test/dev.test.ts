/**
 * True `alchemy dev` end-to-end: spawns the real CLI, which runs Vocs' own
 * dev server as the local `Website.Server` provider. No Function, no storage
 * account and no Front Door are created; the only cloud touch is the state
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

const pagePath = path.join(root, "src", "pages", "guide.mdx");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "# Deployment guide";
const MARKER_V2 = "# Deployment guide dev-v2";

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(pagePath, pageSource);
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 180_000);

test(
  "alchemy dev serves the Vocs site locally with hot reload",
  async () => {
    cli.start();
    const url = await cli.outputUrlWhenReady("url", { tries: 180, delayMs: 1000 });

    // Dev identity: Vocs' dev server, not Front Door.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("azurefd.net");

    const home = await (await fetchOk(url, { tries: 60 })).text();
    expect(home).toContain("Alchemy with Vocs");
    const hello = await (await fetchOk(new URL("/hello.txt", url))).text();
    expect(hello).toContain("Vocs public directory");

    // Vocs' dev server serves the edited page without a deploy.
    fs.writeFileSync(pagePath, pageSource.replace(MARKER, MARKER_V2));
    await cli.pollUntil(
      "hot-reloaded page (v2 marker)",
      async () => {
        try {
          const res = await fetch(new URL("/guide", url));
          if (!res.ok) return undefined;
          return (await res.text()).includes("dev-v2") ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { tries: 120, delayMs: 500 },
    );
  },
  { timeout: 600_000 },
);
