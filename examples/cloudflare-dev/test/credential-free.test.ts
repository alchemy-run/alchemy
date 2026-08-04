/**
 * The headline proof for local-first dev: `alchemy dev` boots an all-local
 * stack (test/fixtures/local-only.run.ts) in a SCRUBBED environment —
 * temp HOME (no ~/.alchemy/profiles.json), no CLOUDFLARE_* / ALCHEMY_* env
 * vars, CI unset — a worker serves, a KV binding roundtrips, and no auth
 * error ever surfaces. `Cloudflare.state()` resolves to the local file
 * store in dev, so state demands no credentials either.
 */
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const alchemyBin = path.join(
  root,
  "node_modules",
  "alchemy",
  "bin",
  "alchemy.ts",
);
const STAGE = "credential-free-test";
const STACK = "CloudflareDevLocalOnly";

let proc: ReturnType<typeof spawn> | undefined;
let tmpHome: string | undefined;
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

/** Fetch with retries — a fresh workerd takes a moment to start serving. */
const fetchOk = async (
  url: string | URL,
  { tries = 20, delayMs = 500 }: { tries?: number; delayMs?: number } = {},
) => {
  let last: Response | undefined;
  for (let i = 0; i < tries; i++) {
    try {
      last = await fetch(url);
      if (last.ok) return last;
    } catch {
      // dev proxy not listening yet
    }
    await Bun.sleep(delayMs);
  }
  throw new Error(
    `GET ${url} never returned 2xx (last status: ${last?.status})\n--- alchemy dev output (tail) ---\n${output.slice(-4000)}`,
  );
};

const outputUrl = (key: string) =>
  output.match(new RegExp(`${key}:\\s*['"]?(http[^\\s'",]+)`))?.[1];

/**
 * A copy of process.env with every credential/profile source removed:
 * - HOME/XDG point at a throwaway dir, so ~/.alchemy/profiles.json and any
 *   cached state-store credentials are invisible.
 * - CLOUDFLARE_* (api token/key/account) and ALCHEMY_* (profile/password)
 *   are dropped.
 * - CI is unset so nothing takes CI shortcuts.
 */
const scrubbedEnv = (home: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("CLOUDFLARE_")) continue;
    if (key.startsWith("ALCHEMY_")) continue;
    if (key.startsWith("WRANGLER_")) continue;
    if (key === "CI" || key === "HOME" || key.startsWith("XDG_")) continue;
    env[key] = value;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  return env;
};

afterAll(async () => {
  if (proc?.pid) {
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
  // Dev state is machine-local (that's the point) — drop the fixture
  // stack's rows so reruns start clean. No cloud destroy: nothing was
  // created in the cloud.
  fs.rmSync(path.join(root, ".alchemy", "state", STACK), {
    recursive: true,
    force: true,
  });
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
}, 60_000);

// TODO(credential-free-dev): un-gate at the wave boundary. The state half is
test(
  "alchemy dev boots an all-local stack with zero Cloudflare credentials",
  async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "alchemy-credfree-"));
    proc = spawn(
      "bun",
      [alchemyBin, "dev", "test/fixtures/local-only.run.ts", "--stage", STAGE],
      {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: scrubbedEnv(tmpHome),
      },
    );
    pump(proc.stdout!);
    pump(proc.stderr!);

    const workerUrl = await pollUntil(
      "localOnlyWorker url in stack outputs",
      () => outputUrl("localOnlyWorker"),
      { tries: 180, delayMs: 1000 },
    );
    expect(workerUrl).toContain("http://localhost");

    // The KV namespace must be a `dev:` row — proof no cloud call ran.
    const kvId = await pollUntil(
      "kvNamespaceId in stack outputs",
      () => output.match(/kvNamespaceId:\s*['"]?(dev:[^\s'",]+)/)?.[1],
      { tries: 30, delayMs: 500 },
    );
    expect(kvId).toStartWith("dev:");

    // The worker serves and the local KV binding roundtrips.
    const body = (await (await fetchOk(workerUrl)).json()) as {
      marker: string;
      value: string | null;
    };
    expect(body.marker).toBe("credential-free-ok");
    expect(body.value).toBe("hello from credential-free dev");

    // No credential demand ever surfaced.
    expect(output).not.toMatch(
      /AuthError|not authenticated|api token|configure a profile|oauth/i,
    );
  },
  { timeout: 300_000 },
);
