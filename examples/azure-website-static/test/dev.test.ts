/**
 * True `alchemy dev` end-to-end: spawns the real CLI, which runs
 * `dev.command` (Vite's dev server) in place of the build. No storage
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

const htmlPath = path.join(root, "index.html");
const htmlSource = fs.readFileSync(htmlPath, "utf8");
const MARKER = "<h1>Static site on Azure</h1>";
const MARKER_V2 = "<h1>Static site on Azure [dev-v2]</h1>";

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(htmlPath, htmlSource);
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 180_000);

test(
  "alchemy dev serves the site from the dev command with live edits",
  async () => {
    cli.start();
    const url = await cli.outputUrlWhenReady("url", { tries: 180, delayMs: 1000 });

    // Dev identity: the local dev server, not Front Door or Blob Storage.
    expect(new URL(url).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
    expect(url).not.toContain("azurefd.net");
    expect(url).not.toContain("web.core.windows.net");

    const home = await (await fetchOk(url)).text();
    expect(home).toContain(MARKER);

    // The dev server serves the edited index.html without a deploy.
    fs.writeFileSync(htmlPath, htmlSource.replace(MARKER, MARKER_V2));
    await cli.pollUntil(
      "reloaded index.html (v2 marker)",
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
