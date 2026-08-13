/**
 * True `alchemy dev` end-to-end for the Foldkit site on Cloudflare: spawns
 * the REAL CLI (mirroring examples/cloudflare-dev/test/dev.test.ts). The
 * worker's Vite source runs `vite createServer` with the injected
 * Cloudflare plugin (workerd inside the Vite pipeline) behind the stable
 * WorkerProxy URL — native Vite HMR, no deploy.
 *
 * Coverage:
 *   - stack output    → `url` is the local WorkerProxy address (port is
 *                       whatever was bound — never hard-coded)
 *   - index HTML      → `/` serves the app shell (client-only SPA)
 *   - HOT RELOAD      → editing index.html is served by Vite's HMR
 *                       without a redeploy
 */
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Spawn the CLI entry directly (not through `bun run` / the cli.js
// launcher) so signals hit the actual CLI process, whose scope teardown
// kills the vite child and the provider sidecars.
const alchemyBin = path.join(
  root,
  "node_modules",
  "alchemy",
  "bin",
  "alchemy.ts",
);
// Isolated stage so this suite never fights integ.test.ts (same stack
// name) over state rows.
const STAGE = "dev-cli-test";

// Hot-reload surface: the app shell. The test rewrites it in place with
// the CLI running, then restores it.
const pagePath = path.join(root, "index.html");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "Foldkit on Cloudflare";
const MARKER_V2 = "Foldkit on Cloudflare [dev-v2]";

let proc: ReturnType<typeof spawn> | undefined;
let output = "";

const pump = (stream: NodeJS.ReadableStream) => {
  stream.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    if (process.env.DEBUG) process.stderr.write(text);
  });
};

/** Bounded poll for a (possibly async) producer to yield a value. */
const pollUntil = async <T>(
  what: string,
  f: () => T | undefined | Promise<T | undefined>,
  { tries = 30, delayMs = 1000 }: { tries?: number; delayMs?: number } = {},
): Promise<T> => {
  for (let i = 0; i < tries; i++) {
    const value = await f();
    if (value !== undefined) return value;
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `Timed out waiting for ${what}.\n--- alchemy dev output (tail) ---\n${output.slice(-4000)}`,
  );
};

/** Fetch with retries — fresh workerd takes a moment to start serving. */
const fetchOk = async (
  url: string | URL,
  { tries = 30, delayMs = 1000 }: { tries?: number; delayMs?: number } = {},
) => {
  let last: Response | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      last = await fetch(url);
      if (last.ok) return last;
    } catch {
      // proxy not listening yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `GET ${url} never returned 2xx (last status: ${last?.status})`,
  );
};

/** Extract the stack-output URL the CLI prints on stdout. */
const outputUrl = () =>
  output.match(/\burl:\s*['"]?(http[^\s'",]+)/)?.[1];

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(pagePath, pageSource);

  if (proc?.pid) {
    // Ctrl-C semantics: signal the whole PROCESS GROUP (the CLI, its
    // `--watch` exec child, and the provider sidecars).
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-proc!.pid!, signal);
      } catch {
        // group already gone
      }
    };
    const exited = new Promise((resolve) => proc!.once("exit", resolve));
    killGroup("SIGINT");
    await Promise.race([exited, Bun.sleep(15_000)]);
    if (proc.exitCode === null && proc.signalCode === null) {
      killGroup("SIGKILL");
      await Promise.race([exited, Bun.sleep(5_000)]);
    }
  }
  if (!process.env.NO_DESTROY) {
    spawnSync("bun", [alchemyBin, "destroy", "--stage", STAGE, "--yes"], {
      cwd: root,
      stdio: "inherit",
      timeout: 120_000,
    });
  }
}, 180_000);

test(
  "alchemy dev serves the Foldkit site locally with hot reload",
  async () => {
    proc = spawn("bun", [alchemyBin, "dev", "--stage", STAGE], {
      cwd: root,
      // Own process group, so teardown can deliver Ctrl-C to the whole
      // tree the way a terminal would.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    pump(proc.stdout!);
    pump(proc.stderr!);

    const url = await pollUntil("url in stack outputs", outputUrl, {
      tries: 180,
      delayMs: 1000,
    });

    // Dev identity: the local WorkerProxy, not workers.dev. The port is
    // whatever was bound — only the URL captured from the CLI's stdout is
    // authoritative.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("workers.dev");

    // The app shell serves through the vite pipeline (client-only SPA —
    // markup renders in the browser, so assert on the shell).
    const home = await (await fetchOk(url)).text();
    expect(home).toContain(MARKER);
    expect(home).toContain('<div id="root">');

    // ── HOT RELOAD: rewrite the app shell with the CLI still running —
    // Vite serves the new markup without a deploy ──
    fs.writeFileSync(pagePath, pageSource.replace(MARKER, MARKER_V2));
    await pollUntil(
      "hot-reloaded page (v2 marker)",
      async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) return undefined;
          const html = await res.text();
          return html.includes(MARKER_V2) ? true : undefined;
        } catch {
          return undefined; // mid-reload
        }
      },
      { tries: 120, delayMs: 500 },
    );

    // Restore — the swap back is itself a second hot reload and leaves
    // the checked-in tree clean.
    fs.writeFileSync(pagePath, pageSource);
    await pollUntil(
      "restored page (v2 marker gone)",
      async () => {
        try {
          const res = await fetch(url);
          if (!res.ok) return undefined;
          const html = await res.text();
          return html.includes(MARKER_V2) ? undefined : true;
        } catch {
          return undefined; // mid-reload
        }
      },
      { tries: 120, delayMs: 500 },
    );
  },
  { timeout: 600_000 },
);
