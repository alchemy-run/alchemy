/**
 * True `alchemy dev` end-to-end for the Vite SPA: spawns the REAL CLI
 * (mirroring examples/aws-website-nextjs/test/dev.test.ts). The frontend
 * is Vite's own dev server (`dev.command`); the effect backend deploys
 * into the local Lambda emulator (Docker) and serves /api/* at the
 * stack's `serverUrl` output. No CloudFront, no S3 — the only cloud touch
 * is the state store — S3, SQS, and the Lambda are all emulated locally.
 *
 * Coverage:
 *   - stack outputs   → `url` is the Vite dev server, `serverUrl` the
 *                       emulated Lambda's Function URL
 *   - SPA shell       → `/` serves index.html through Vite
 *   - HttpApi         → GET `serverUrl`/api/visits answers from the
 *                       emulated effect Lambda against the real table
 *   - HOT RELOAD      → editing src/App.tsx is served by Vite's module
 *                       transform without a redeploy
 */
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Spawn the CLI entry directly (not through `bun run` / the cli.js
// launcher) so signals hit the actual CLI process, whose scope teardown
// kills the dev server and the provider sidecars.
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

// The local Lambda emulator runs in Docker — without it there is no dev
// backend to probe.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

// Hot-reload surface: the root component. The test rewrites it in place
// with the CLI running, then restores it.
const appPath = path.join(root, "src", "App.tsx");
const appSource = fs.readFileSync(appPath, "utf8");
const MARKER = "A Vite SPA with an effect-native backend.";
const MARKER_V2 = "A Vite SPA with an effect-native backend. [dev-v2]";

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

/** Fetch with retries — the dev server takes a moment to start serving. */
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
      // dev server not listening yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `GET ${url} never returned 2xx (last status: ${last?.status})`,
  );
};

/** Extract a named http(s) output the CLI prints on stdout. */
const outputUrl = (key: string) => () =>
  output.match(new RegExp(`\\b${key}:\\s*['"]?(http[^\\s'",]+)`))?.[1];

afterAll(async () => {
  // Always leave the repo tree clean, even on a mid-reload failure.
  fs.writeFileSync(appPath, appSource);

  if (proc?.pid) {
    // Ctrl-C semantics: signal the whole PROCESS GROUP (the CLI, its
    // Vite child, and the provider sidecars).
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

test.skipIf(!dockerAvailable)(
  "alchemy dev serves the SPA through Vite and /api/* through the emulated Lambda",
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

    const url = await pollUntil("url in stack outputs", outputUrl("url"), {
      tries: 180,
      delayMs: 1000,
    });
    const serverUrl = await pollUntil(
      "serverUrl in stack outputs",
      outputUrl("serverUrl"),
      { tries: 60, delayMs: 1000 },
    );

    // Dev identity: Vite's own dev server, not CloudFront; the backend is
    // the emulator's Function URL, not a real lambda-url.amazonaws.com.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("cloudfront.net");
    expect(serverUrl).toContain("localhost");

    // The SPA shell serves through Vite.
    const home = await (await fetchOk(url)).text();
    expect(home).toContain('<div id="root">');

    // Vite serves the root component as a transformed module — the
    // hot-reload surface this test rewrites below.
    const app = await (await fetchOk(new URL("/src/App.tsx", url))).text();
    expect(app).toContain(MARKER);

    // The HttpApi answers from the emulated effect Lambda against the
    // locally emulated S3 bucket. First invoke pulls the Lambda
    // runtime image, so give it a generous window.
    const visits = (await (
      await fetchOk(new URL("/api/visits", serverUrl), {
        tries: 120,
        delayMs: 2000,
      })
    ).json()) as { count: number };
    expect(visits.count).toBeGreaterThanOrEqual(0);

    // ── HOT RELOAD: rewrite the root component with the CLI still
    // running — Vite serves the new module without a deploy ──────────────
    fs.writeFileSync(appPath, appSource.replace(MARKER, MARKER_V2));
    await pollUntil(
      "hot-reloaded module (v2 marker)",
      async () => {
        try {
          const res = await fetch(new URL("/src/App.tsx", url));
          if (!res.ok) return undefined;
          const source = await res.text();
          return source.includes(MARKER_V2) ? true : undefined;
        } catch {
          return undefined; // mid-reload
        }
      },
      { tries: 120, delayMs: 500 },
    );

    // Restore — the swap back is itself a second hot reload and leaves
    // the checked-in tree clean.
    fs.writeFileSync(appPath, appSource);
    await pollUntil(
      "restored module (v2 marker gone)",
      async () => {
        try {
          const res = await fetch(new URL("/src/App.tsx", url));
          if (!res.ok) return undefined;
          const source = await res.text();
          return source.includes(MARKER_V2) ? undefined : true;
        } catch {
          return undefined; // mid-reload
        }
      },
      { tries: 120, delayMs: 500 },
    );
  },
  { timeout: 900_000 },
);
