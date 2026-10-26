/**
 * True `alchemy dev` end-to-end: spawns the real CLI, which runs React
 * Router's own Vite dev server as the local `Website.Server` provider. No
 * storage account, Function, or Front Door is created; the only cloud touch
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

const cardPath = path.join(root, "app", "routes", "home.tsx");
const cardSource = fs.readFileSync(cardPath, "utf8");
const MARKER = "Styled with Tailwind CSS";
const MARKER_V2 = "Styled with Tailwind CSS [dev-v2]";

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(cardPath, cardSource);
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 180_000);

test(
  "alchemy dev serves the React Router app locally with hot reload",
  async () => {
    cli.start();
    const url = await cli.outputUrlWhenReady("url", { tries: 180, delayMs: 1000 });

    // Dev identity: React Router's dev server, not Front Door.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("azurefd.net");

    const home = await (await fetchOk(url)).text();
    expect(home).toContain(MARKER);
    // `env` reaches the dev server's process env.
    expect(home).toContain("Hello from React Router on Azure!");

    // The dev server renders the edited route without a deploy.
    fs.writeFileSync(cardPath, cardSource.replace(`"${MARKER}"`, `"${MARKER_V2}"`));
    await cli.pollUntil(
      "re-rendered home.tsx (v2 marker)",
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
