import { unwrapRpcHandlers } from "@/Local/RpcSerialization.ts";
import type { RpcProxyApi } from "@/Local/RpcServer.ts";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  spawn,
  type ChildProcess as NodeChildProcess,
} from "node:child_process";
import { runtimes } from "./fixtures/runtimes.ts";

const FIXTURE_TS = new URL("./fixtures/rpc-server-entry.ts", import.meta.url)
  .pathname;

const ADDRESS_RE = /<ALCHEMY_RPC_ADDRESS>(.+?)<\/ALCHEMY_RPC_ADDRESS>/;

const sampleEnv = () =>
  JSON.stringify({
    profile: null,
    envFile: null,
    alchemyContext: {
      dotAlchemy: "/tmp/.alchemy",
      updateStateStore: false,
      dev: true,
      adopt: false,
    },
    stack: { name: "test", stage: "dev" },
  });

interface SpawnedFixture {
  readonly child: NodeChildProcess;
  readonly url: string;
  readonly stderr: string;
  kill: () => Promise<number | null>;
}

const spawnFixture = async (
  argv: Array<string>,
  opts: { waitForAddress?: boolean } = {},
): Promise<SpawnedFixture> => {
  const child = spawn(argv[0]!, argv.slice(1), {
    env: {
      ...process.env,
      ALCHEMY_RPC_SERVER_ENVIRONMENT: sampleEnv(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr!.on("data", (d) => {
    stderr += d.toString();
  });

  const waitForAddress = opts.waitForAddress !== false;
  let url = "";
  if (waitForAddress) {
    url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`address timeout. stderr=${stderr}`)),
        15_000,
      );
      const onData = () => {
        const m = stdout.match(ADDRESS_RE);
        if (m) {
          clearTimeout(t);
          child.stdout!.off("data", onData);
          resolve(m[1]!);
        }
      };
      child.stdout!.on("data", onData);
      child.on("exit", () => {
        clearTimeout(t);
        const m = stdout.match(ADDRESS_RE);
        if (m) resolve(m[1]!);
        else reject(new Error(`process exited early. stderr=${stderr}`));
      });
    });
  }

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  return {
    child,
    url,
    get stderr() {
      return stderr;
    },
    kill: async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 1_000);
      }
      return await exited;
    },
  };
};

const waitForExit = (child: NodeChildProcess, ms: number) =>
  new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const t = setTimeout(
      () => reject(new Error(`exit timeout after ${ms}ms`)),
      ms,
    );
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });

for (const runtime of runtimes()) {
  describe.skipIf(!runtime.available)(
    `Local.RpcServer (${runtime.name})`,
    () => {
      const fixtures: Array<SpawnedFixture> = [];

      afterEach(async () => {
        await Promise.all(fixtures.splice(0).map((f) => f.kill()));
      });

      const launch = async (opts: { waitForAddress?: boolean } = {}) => {
        const f = await spawnFixture(runtime.argv(FIXTURE_TS), opts);
        fixtures.push(f);
        return f;
      };

      it("prints the RPC address marker on stdout and accepts /parent + session connections", async () => {
        const fixture = await launch();
        expect(fixture.url).toMatch(/^ws:\/\//);

        // Open parent socket to satisfy the connect handshake.
        const parent = new WebSocket(new URL("/parent", fixture.url));
        await new Promise<void>((resolve, reject) => {
          parent.addEventListener("open", () => resolve(), { once: true });
          parent.addEventListener(
            "error",
            () => reject(new Error("parent ws failed")),
            { once: true },
          );
        });

        // Now run a real RPC call through a session websocket.
        const stub = newWebSocketRpcSession(
          fixture.url,
        ) as RpcStub<RpcProxyApi>;
        const provider = await stub.getProvider("Test.Echo");
        const handlers = unwrapRpcHandlers(provider as any) as {
          echo: (msg: string) => Effect.Effect<string>;
        };
        const result = await Effect.runPromise(handlers.echo("hello"));
        expect(result).toBe("echo:hello");

        // Closing the parent ws should cause the child to exit promptly.
        parent.close();
        const code = await waitForExit(fixture.child, 5_000);
        expect(code).not.toBeNull();
      }, 30_000);

      it("exits if the parent never connects within ~10s", async () => {
        const start = Date.now();
        const fixture = await launch();
        // Never open /parent — the server should self-terminate via the
        // launch() timeout.
        const code = await waitForExit(fixture.child, 20_000);
        const elapsed = Date.now() - start;
        expect(code).not.toBeNull();
        // Must exit reasonably soon after the 10s connect timeout, not at
        // the vitest timeout. Give a generous upper bound.
        expect(elapsed).toBeLessThan(18_000);
      }, 30_000);
    },
  );
}
