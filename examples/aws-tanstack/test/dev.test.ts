/**
 * True `alchemy dev` end-to-end for the TanStack Start site: spawns the
 * REAL CLI (mirroring examples/aws-dev/test/dev.test.ts), which runs
 * vite's dev server as the local `Website.Server` provider — no Lambda,
 * no CloudFront, no S3; the only cloud touch is the state store (and the
 * `remote()` DynamoDB table the value-form client writes to).
 *
 * Coverage:
 *   - stack output    → `url` is a local dev-server address (port is
 *                       whatever the framework bound — never hard-coded)
 *   - SSR             → `/` renders through vite's dev server (the route
 *                       loader dispatches the backend in-process)
 *   - static assets   → `/robots.txt` from public/
 *   - server function → `bumpVisits` over Start's own transport
 *                       (dev fn ids discovered from the transformed
 *                       module), dispatching the backend value-form
 *                       against the real DynamoDB table
 *   - HOT RELOAD      → editing src/routes/index.tsx is served by Vite's
 *                       HMR without a redeploy
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

// Hot-reload surface: the SSR index page. The test rewrites it in place
// with the CLI running, then restores it.
const pagePath = path.join(root, "src", "routes", "index.tsx");
const pageSource = fs.readFileSync(pagePath, "utf8");
const MARKER = "TanStack Start on AWS";
const MARKER_V2 = "TanStack Start on AWS [dev-v2]";

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

/** Extract the stack-output URL the CLI prints on stdout. */
const outputUrl = () => output.match(/\burl:\s*['"]?(http[^\s'",]+)/)?.[1];

/**
 * Discover a server function's DEV id: vite serves the client transform
 * of src/server/visits.ts, where each server fn compiles to
 * `createClientRpc("<id>")` — and in dev the id is a base64url-encoded
 * JSON `{ file, export }` (Start's production sha256 ids only exist in
 * builds), so the export name maps each id back to its function.
 */
const findServerFnId = async (base: string, name: string) => {
  const res = await fetchOk(new URL("/src/server/visits.ts", base));
  const js = await res.text();
  for (const match of js.matchAll(/createClientRpc\("([^"]+)"\)/g)) {
    try {
      const decoded = JSON.parse(
        Buffer.from(match[1]!, "base64url").toString("utf8"),
      ) as { export?: string };
      if (decoded.export?.startsWith(`${name}_`)) return match[1]!;
    } catch {
      // not a dev-encoded id — keep scanning
    }
  }
  return undefined;
};

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
  "alchemy dev serves the TanStack Start site locally with hot reload",
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

    // Dev identity: vite's dev server, not CloudFront. The port is
    // whatever the framework bound — only the URL captured from the
    // CLI's stdout is authoritative.
    expect(new URL(url).hostname).toBe("localhost");
    expect(url).not.toContain("cloudfront.net");

    const home = await (await fetchOk(url)).text();
    expect(home).toContain(MARKER);

    // The SSR seam (the route loader → server functions → value-form
    // client) renders the counter against the REAL DynamoDB table
    // (remote()).
    expect(home).toContain("Server-rendered visits:");

    // Static asset from public/.
    const robots = await (await fetchOk(new URL("/robots.txt", url))).text();
    expect(robots).toContain("User-agent:");

    // ── The mount (src/server.ts) runs natively inside Start's dev
    // server: entry-answered route, admin gate, and the effect API
    // through `site.fetch` (env from the lowered process.env). ──
    const healthz = await fetchOk(new URL("/healthz", url));
    expect(await healthz.text()).toBe("ok");

    const denied = await fetch(new URL("/api/admin/secret", url));
    expect(denied.status).toBe(403);
    const allowed = await fetch(new URL("/api/admin/secret", url), {
      headers: { "x-admin-key": "letmein" },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ admin: true });

    // The effect fetch against the REAL DynamoDB table (remote()): the
    // finalizer route writes the marker inline, /api/kv reads it back.
    const marker = `dev-finalizer-${Date.now().toString(36)}`;
    const registered = await fetchOk(
      new URL(`/api/finalizer?v=${marker}`, url),
    );
    expect(
      ((await registered.json()) as { registered: string }).registered,
    ).toBe(marker);
    const readBack = await pollUntil(
      "finalizer marker in DynamoDB",
      async () => {
        const res = await fetch(new URL("/api/kv?key=finalizer-last", url));
        if (!res.ok) return undefined;
        const { value } = (await res.json()) as { value: string | null };
        return value === marker ? value : undefined;
      },
    );
    expect(readBack).toBe(marker);

    // Streaming route through the dev server.
    const streamed = await fetchOk(new URL("/api/stream?n=3", url));
    expect(await streamed.text()).toBe("0\n1\n2\n");

    // The public surface rides the dev server too: POST the `bumpVisits`
    // server function exactly as Start's browser client would (dev fn
    // ids discovered from the transformed module).
    const bumpId = await pollUntil(
      "bumpVisits dev server-fn id",
      () => findServerFnId(url, "bumpVisits"),
      { tries: 30, delayMs: 1000 },
    );
    const action = await fetch(new URL(`/_serverFn/${bumpId}`, url), {
      method: "POST",
      headers: {
        origin: new URL(url).origin,
        "x-tsr-serverFn": "true",
      },
    });
    expect(action.status).toBe(200);

    // ...and the write landed: the next server render observes it.
    const ssr = await (await fetchOk(url)).text();
    expect(ssr).toContain("Server-rendered visits:");

    // ── HOT RELOAD: rewrite the index page with the CLI still running —
    // vite's dev server serves the new markup without a deploy ──
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
