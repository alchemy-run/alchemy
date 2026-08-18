/**
 * True `alchemy dev` end-to-end for the monorepo: spawns the REAL CLI
 * from the monorepo root (mirroring examples/aws-website-nextjs), which
 * starts ONE framework dev server per nested package as the local
 * `Website.Server` provider — no Lambda, no CloudFront, no S3; the only
 * cloud touch is the state store.
 *
 * Coverage, for each of the six nested packages
 * (packages/nextjs|nuxt|astro|sveltekit|tanstack|vite):
 *   - stack output   → `<framework>Url` is a local dev-server address
 *                      (port is whatever the framework bound)
 *   - effect fetch   → `/api/marker` serves the package's effect program
 *                      through the framework dev server (the dev
 *                      middleware mount), proving the nested-package
 *                      `rootDir` + `main` wiring resolves
 *   - SSR            → `/` renders through the framework dev server
 */
import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Spawn the CLI entry directly (not through `bun run` / the cli.js
// launcher) so signals hit the actual CLI process, whose scope teardown
// kills the dev servers and the provider sidecars.
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

const FRAMEWORKS = [
  { output: "nextjsUrl", marker: "monorepo-nextjs-effect", page: "monorepo-nextjs-page" },
  { output: "nuxtUrl", marker: "monorepo-nuxt-effect", page: "monorepo-nuxt-page" },
  { output: "astroUrl", marker: "monorepo-astro-effect", page: "monorepo-astro-page" },
  { output: "sveltekitUrl", marker: "monorepo-sveltekit-effect", page: "monorepo-sveltekit-page" },
  { output: "tanstackUrl", marker: "monorepo-tanstack-effect", page: "monorepo-tanstack-page" },
] as const;

// The Vite SPA splits in dev: the Vite dev server serves the page at
// `viteUrl` while the effect program serves /api/* from the local Lambda
// emulator at `viteServerUrl` (no edge to unify them locally).
const VITE = {
  pageOutput: "viteUrl",
  apiOutput: "viteServerUrl",
  marker: "monorepo-vite-effect",
  page: "monorepo-vite-page",
} as const;

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

/** Fetch with retries — the dev servers take a moment to start serving. */
const fetchOk = async (
  url: string | URL,
  { tries = 60, delayMs = 1000 }: { tries?: number; delayMs?: number } = {},
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
    `GET ${url} never returned 2xx (last status: ${last?.status}).\n--- alchemy dev output (tail) ---\n${output.slice(-4000)}`,
  );
};

/** Extract a named stack-output URL the CLI prints on stdout. */
const outputUrl = (key: string) =>
  output.match(new RegExp(`\\b${key}:\\s*['"]?(http[^\\s'",]+)`))?.[1];

afterAll(async () => {
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
      timeout: 180_000,
    });
  }
}, 240_000);

test(
  "alchemy dev serves every nested framework package locally",
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

    // All the dev servers boot concurrently on the first dev run
    // (framework installs are already in place; the slowest is Next's
    // first compile) — wait for every output before asserting.
    const urls: Record<string, string> = {};
    for (const framework of FRAMEWORKS) {
      urls[framework.output] = await pollUntil(
        `${framework.output} in stack outputs`,
        () => outputUrl(framework.output),
        { tries: 300, delayMs: 1000 },
      );
    }
    for (const key of [VITE.pageOutput, VITE.apiOutput]) {
      urls[key] = await pollUntil(
        `${key} in stack outputs`,
        () => outputUrl(key),
        { tries: 300, delayMs: 1000 },
      );
    }

    for (const framework of FRAMEWORKS) {
      const url = urls[framework.output]!;
      // Dev identity: the framework dev server, not CloudFront. The port
      // is whatever the framework bound — only the URL captured from the
      // CLI's stdout is authoritative.
      expect(new URL(url).hostname).toBe("localhost");
      expect(url).not.toContain("cloudfront.net");

      // The effect fetch serves /api/marker through the framework dev
      // server — the nested-package rootDir/main wiring, end to end.
      const marker = (await (
        await fetchOk(new URL("/api/marker", url))
      ).json()) as { marker: string };
      expect(marker).toEqual({ marker: framework.marker });

      // SSR through the framework dev server.
      const home = await (await fetchOk(url)).text();
      expect(home).toContain(framework.page);
    }

    // The Vite SPA's split dev topology: static page from the Vite dev
    // server, effect /api/* from the emulated Lambda.
    expect(new URL(urls[VITE.pageOutput]!).hostname).toBe("localhost");
    expect(urls[VITE.apiOutput]!).toContain("localhost");
    const viteMarker = (await (
      await fetchOk(new URL("/api/marker", urls[VITE.apiOutput]!))
    ).json()) as { marker: string };
    expect(viteMarker).toEqual({ marker: VITE.marker });
    const viteHome = await (await fetchOk(urls[VITE.pageOutput]!)).text();
    expect(viteHome).toContain(VITE.page);
  },
  { timeout: 600_000 },
);
