/**
 * True `alchemy dev` end-to-end: spawns the real CLI, which runs
 * `vinext dev` as the local `Website.Server` provider. No storage account,
 * Function, or Front Door is created; the only cloud touch is the state
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

const pagePath = path.join(root, "app", "page.tsx");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "Hello from vinext on Azure!";
const MARKER_V2 = "Hello from vinext on Azure! [dev-v2]";

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(pagePath, pageSource);
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 180_000);

test(
  "alchemy dev serves the vinext app locally with hot reload",
  async () => {
    cli.start();
    const url = await cli.outputUrlWhenReady("url", { tries: 180, delayMs: 1000 });

    // Dev identity: `vinext dev`, not Front Door.
    expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);

    const home = await (await fetchOk(url)).text();
    expect(home).toContain(MARKER);
    // `env` reaches the dev server's process env.
    const api = await (await fetchOk(`${url.replace(/\/+$/, "")}/api/hello?name=Alchemy`)).json();
    expect(api).toEqual({ name: "Alchemy", greeting: "Hello from vinext on a Function!" });

    // The dev server renders the edited page without a deploy.
    fs.writeFileSync(pagePath, pageSource.replace(MARKER, MARKER_V2));
    await cli.pollUntil(
      "re-rendered page.tsx (v2 marker)",
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
