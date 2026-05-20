import { exitHook } from "@alchemy.run/node-utils";
import { Deferred } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeChildProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { httpServer } from "../Util/PlatformServices.ts";
import {
  CONTEXT_ENV_KEY,
  type RpcProcessContext,
} from "./RpcProcessContext.ts";

export class RpcSpawner extends Context.Service<
  RpcSpawner,
  {
    readonly url: string;
  }
>()("RpcSpawner") {}

export const make = Effect.fnUntraced(function* ({
  profile,
  envFile,
}: Pick<RpcProcessContext, "profile" | "envFile">) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const processes = MutableHashMap.empty<
    string,
    {
      url: string;
      isRunning: Effect.Effect<boolean, PlatformError, never>;
      kill: Effect.Effect<void, PlatformError, never>;
    }
  >();

  const spawn = Effect.fnUntraced(function* (
    mainUrl: string,
    {
      alchemyContext,
      stack,
    }: Pick<RpcProcessContext, "alchemyContext" | "stack">,
  ) {
    const bin = typeof globalThis.Bun !== "undefined" ? "bun" : "node";
    const main = fileURLToPath(mainUrl);
    const context: RpcProcessContext = {
      profile,
      envFile,
      alchemyContext,
      stack,
    };
    const command = ChildProcess.make(
      bin,
      { bun: ["run", main], node: [main.replace(".ts", ".js")] }[bin],
      {
        stdout: "pipe",
        stderr: "inherit",
        detached: false,
        env: {
          [CONTEXT_ENV_KEY]: JSON.stringify(context),
        },
        extendEnv: true,
      },
    );
    const handle = yield* spawner.spawn(command);
    const unregister = exitHook(() => {
      console.log("unregistering", handle.pid);
      killProcessGroup(handle.pid, "SIGKILL");
    });
    const kill = handle
      .kill({ forceKillAfter: "500 millis" })
      .pipe(Effect.tap(() => Effect.sync(unregister)));
    yield* Effect.addFinalizer(() => kill.pipe(Effect.ignore));
    const urlResult = yield* Deferred.make<string>();
    let done = false;
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (!done) {
          const match = line.match(RPC_ADDRESS_REGEX);
          if (match) {
            done = true;
            return Deferred.succeed(urlResult, match[2]);
          }
          return Effect.void;
        }
        console.log("[stdout]", line);
        return Effect.void;
      }),
      Effect.forkScoped,
    );
    const url = yield* Deferred.await(urlResult);
    const ws = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocket(new URL("/signal", url))),
      (ws) => Effect.sync(() => ws.close()),
    );
    return {
      url,
      isRunning: Effect.zipWith(
        handle.isRunning,
        Effect.sync(() => ws.readyState === WebSocket.OPEN),
        (a, b) => a && b,
        { concurrent: true },
      ),
      kill,
    };
  });

  const register = Effect.fnUntraced(function* (
    mainUrl: string,
    context: Pick<RpcProcessContext, "alchemyContext" | "stack">,
  ) {
    const existing = MutableHashMap.get(processes, mainUrl);
    if (Option.isSome(existing)) {
      if (yield* existing.value.isRunning) {
        console.log("existing", existing.value.url);
        return existing.value.url;
      }
      console.log("killing", mainUrl);
      yield* existing.value.kill;
      console.log("killed", mainUrl);
      MutableHashMap.remove(processes, mainUrl);
    }
    console.log("spawning", mainUrl);
    const child = yield* spawn(mainUrl, context).pipe(Scope.provide(scope));
    MutableHashMap.set(processes, mainUrl, child);
    console.log("spawned", mainUrl, child.url);
    return child.url;
  });

  const server = yield* HttpServer.HttpServer;

  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const { mainUrl, context } = yield* request.json as Effect.Effect<{
        mainUrl: string;
        context: Pick<RpcProcessContext, "alchemyContext" | "stack">;
      }>;
      const url = yield* register(mainUrl, context);
      return HttpServerResponse.text(url);
    }),
  );

  return RpcSpawner.of({
    url: HttpServer.formatAddress(server.address),
  });
});

export const layerServer = (
  context: Pick<RpcProcessContext, "profile" | "envFile">,
) => Layer.effect(RpcSpawner, make(context)).pipe(Layer.provide(httpServer()));

const RPC_ADDRESS_REGEX =
  /(<ALCHEMY_RPC_ADDRESS>)(.+)(<\/ALCHEMY_RPC_ADDRESS>)/;

const getRpcAddress = (stdout: Stream.Stream<Uint8Array, PlatformError>) => {
  const deferred = Deferred.makeUnsafe<string>();
  let done = false;

  const fiber = stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) => {
      console.log("stdout", line);
      if (!done) {
        const match = line.match(RPC_ADDRESS_REGEX);
        if (match) {
          return Deferred.succeed(deferred, match[2]);
        }
      }
      return Effect.void;
    }),
    Effect.forkChild,
  );
  return Effect.all([Deferred.await(deferred), fiber]).pipe(
    Effect.map(([url]) => url),
  );
};

const killProcessGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    if (process.platform === "win32") {
      NodeChildProcess.execSync(`taskkill /pid ${pid} /T /F`);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // ignore errors during best-effort cleanup
  }
};
