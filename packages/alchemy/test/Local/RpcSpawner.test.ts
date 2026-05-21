import { unwrapRpcHandlers } from "@/Local/RpcSerialization.ts";
import type { RpcProxyApi } from "@/Local/RpcServer.ts";
import {
  layerServer,
  RpcSpawner,
  type RpcSpawnPayload,
} from "@/Local/RpcSpawner.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { spawnSync } from "node:child_process";

const FIXTURE_TS_URL = new URL(
  "./fixtures/rpc-server-entry.ts",
  import.meta.url,
).toString();
const CRASH_FIXTURE_TS_URL = new URL(
  "./fixtures/rpc-server-crash.ts",
  import.meta.url,
).toString();

const samplePayload = (
  serverEntryUrl: string,
  stackName = "test",
): RpcSpawnPayload => ({
  serverEntryUrl,
  alchemyContext: {
    dotAlchemy: "/tmp/.alchemy",
    updateStateStore: false,
    dev: true,
    adopt: false,
  },
  stack: { name: stackName, stage: "dev" },
});

/**
 * Boots an `RpcSpawner` on a background fiber and returns its url. Closing
 * the returned `close` interrupts the fiber, which runs the layer/scope
 * finalizers (killing all spawned children).
 */
const withSpawner = async () => {
  const SpawnerLayer = layerServer({ profile: undefined, envFile: undefined });
  const urlDeferred = await Effect.runPromise(Deferred.make<string>());
  const stop = await Effect.runPromise(Deferred.make<void>());
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const sp = yield* RpcSpawner;
      yield* Deferred.succeed(urlDeferred, sp.url);
      yield* Deferred.await(stop);
    }).pipe(
      Effect.provide(Layer.provide(SpawnerLayer, PlatformServices)),
      Effect.scoped,
    ),
  );
  const url = await Effect.runPromise(Deferred.await(urlDeferred));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Effect.runPromise(Deferred.succeed(stop, void 0));
    await Effect.runPromise(Fiber.join(fiber));
  };
  return { url, close };
};

interface PostResult {
  readonly status: number;
  readonly body: string;
}

const postRaw = async (url: string, body: unknown): Promise<PostResult> => {
  const res = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return { status: res.status, body: await res.text() };
};

const post = async (url: string, body: unknown): Promise<string> => {
  const r = await postRaw(url, body);
  if (r.status !== 200) {
    throw new Error(`spawn POST failed: ${r.status} ${r.body}`);
  }
  return r.body;
};

const pidOf = (wsUrl: string): number | undefined => {
  const port = new URL(wsUrl).port;
  const r = spawnSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return undefined;
  const pid = Number.parseInt(r.stdout.trim().split("\n")[0]!, 10);
  return Number.isFinite(pid) ? pid : undefined;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
};

const callEcho = async (rpcUrl: string, msg: string): Promise<string> => {
  const parent = new WebSocket(new URL("/parent", rpcUrl));
  await new Promise<void>((resolve, reject) => {
    parent.addEventListener("open", () => resolve(), { once: true });
    parent.addEventListener(
      "error",
      () => reject(new Error("parent ws failed")),
      { once: true },
    );
  });
  try {
    const stub = newWebSocketRpcSession(rpcUrl) as RpcStub<RpcProxyApi>;
    const provider = await stub.getProvider("Test.Echo");
    const handlers = unwrapRpcHandlers(provider as any) as {
      echo: (m: string) => Effect.Effect<string>;
    };
    return await Effect.runPromise(handlers.echo(msg));
  } finally {
    parent.close();
  }
};

// The spawner picks the current runtime when spawning children. These tests
// only verify behavior under whichever runtime vitest is in. Run vitest under
// both bun and node to get full coverage.
describe(`Local.RpcSpawner (runtime=${typeof globalThis.Bun !== "undefined" ? "bun" : "node"})`, () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((c) => c().catch(() => {})));
  });

  it("POST returns a ws url whose RPC end-to-end call hits the fixture", async () => {
    const { url, close } = await withSpawner();
    cleanups.push(close);
    const wsUrl = await post(url, samplePayload(FIXTURE_TS_URL));
    expect(wsUrl).toMatch(/^ws:\/\//);
    const result = await callEcho(wsUrl, "hello");
    expect(result).toBe("echo:hello");
  }, 60_000);

  it("caches the child by payload: a second POST returns the same url", async () => {
    const { url, close } = await withSpawner();
    cleanups.push(close);
    const payload = samplePayload(FIXTURE_TS_URL);
    const first = await post(url, payload);
    const second = await post(url, payload);
    expect(second).toBe(first);
    const pid = pidOf(first);
    if (pid !== undefined) {
      expect(isAlive(pid)).toBe(true);
    }
  }, 60_000);

  it("distinct payloads spawn distinct children with distinct urls", async () => {
    const { url, close } = await withSpawner();
    cleanups.push(close);
    const a = await post(url, samplePayload(FIXTURE_TS_URL, "stack-a"));
    const b = await post(url, samplePayload(FIXTURE_TS_URL, "stack-b"));
    expect(a).not.toBe(b);
  }, 60_000);

  it("closing the spawner's scope kills all spawned children", async () => {
    const { url, close } = await withSpawner();
    const wsUrl = await post(url, samplePayload(FIXTURE_TS_URL));
    const pid = pidOf(wsUrl);
    await close();
    if (pid !== undefined) {
      const dead = await waitUntil(() => !isAlive(pid), 5_000);
      expect(dead).toBe(true);
    }
  }, 60_000);

  it("url returned for a crash-on-boot fixture is not a usable RPC endpoint", async () => {
    // The crash fixture prints the address marker then exits. The
    // spawner's health check is best-effort: depending on race-timing the
    // POST may return a bogus url or surface a 500 once the retry budget
    // is drained. The invariant we *can* assert is that callers cannot
    // successfully open a parent websocket to the returned url.
    const { url, close } = await withSpawner();
    cleanups.push(close);
    let failed = false;
    for (let i = 0; i < 4 && !failed; i++) {
      const r = await postRaw(url, samplePayload(CRASH_FIXTURE_TS_URL));
      if (r.status !== 200) {
        failed = true;
        break;
      }
      const usable = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(new URL("/parent", r.body));
        const t = setTimeout(() => {
          ws.close();
          resolve(false);
        }, 1_500);
        ws.addEventListener(
          "open",
          () => {
            clearTimeout(t);
            ws.close();
            resolve(true);
          },
          { once: true },
        );
        ws.addEventListener(
          "error",
          () => {
            clearTimeout(t);
            resolve(false);
          },
          { once: true },
        );
        ws.addEventListener(
          "close",
          () => {
            clearTimeout(t);
            resolve(false);
          },
          { once: true },
        );
      });
      if (!usable) {
        failed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(failed).toBe(true);
  }, 60_000);
});
