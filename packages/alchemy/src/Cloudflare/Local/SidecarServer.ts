import * as Server from "@distilled.cloud/cloudflare-runtime/server";
import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as Bundle from "../../Bundle/Bundle.ts";
import * as RpcServer from "../../Sidecar/RpcServer.ts";
import { provideLayerScoped } from "../../Util/layer-scoped.ts";
import { PlatformServices, runMain } from "../../Util/PlatformServices.ts";
import { WorkerBundle } from "../Workers/WorkerBundle.ts";
import { Sidecar, SidecarSchema, type ServeOptions } from "./Sidecar.ts";

const SidecarServer = Effect.gen(function* () {
  const server = yield* Server.Server;
  const fibers = new Map<
    string,
    {
      deferred: Deferred.Deferred<Server.ServeResult, Server.ServeError>;
      fiber: Fiber.Fiber<void, Server.ServeError | Bundle.BundleError>;
      hash: number;
    }
  >();
  const scope = yield* Effect.scope;
  const bundle = yield* WorkerBundle;

  const stop = Effect.fn(function* (name: string) {
    yield* server.stop(name);
    const fiber = fibers.get(name);
    if (fiber) {
      yield* Fiber.interrupt(fiber.fiber);
      fibers.delete(name);
    }
  });

  return Sidecar.of({
    serve: Effect.fn(function* (worker: ServeOptions) {
      const hash = Hash.structure(worker);
      const existing = fibers.get(worker.name);
      if (existing) {
        if (existing.hash === hash) {
          return yield* Deferred.await(existing.deferred);
        }
        yield* stop(worker.name);
      }
      const deferred = yield* Deferred.make<
        Server.ServeResult,
        Server.ServeError
      >();
      let start = Date.now();
      const fiber = yield* bundle.watch(worker).pipe(
        Stream.tap((event) => {
          if (event._tag === "Start") {
            start = Date.now();
            return Effect.log(`[${worker.id}] Bundle start`);
          }
          if (event._tag === "Error") {
            return Effect.logError(`[${worker.id}] Bundle error`, event.error);
          }
          return Effect.void;
        }),
        Stream.filterMap((event) =>
          event._tag === "Success"
            ? Result.succeed(event.output)
            : Result.failVoid,
        ),
        Stream.changesWithEffect((a, b) =>
          Effect.succeed(a.hash === b.hash).pipe(
            Effect.tap((isSame) =>
              isSame
                ? Effect.log(`[${worker.id}] No changes detected`)
                : Effect.void,
            ),
          ),
        ),
        Stream.map(bundleOutputToWorkerd),
        Stream.mapEffect((modules) =>
          server
            .start({
              name: worker.id.toLowerCase(),
              accountId: worker.accountId,
              compatibilityDate: worker.compatibility.date,
              compatibilityFlags: worker.compatibility.flags,
              bindings: worker.bindings,
              durableObjectNamespaces: worker.durableObjectNamespaces,
              modules,
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) => {
                const isDone = Deferred.isDoneUnsafe(deferred);
                if (exit._tag === "Success") {
                  return Effect.log(
                    `[${worker.id}] ${isDone ? "Updated" : "Started"} in ${Math.round(Date.now() - start)}ms`,
                  );
                }
                if (isDone) {
                  return Effect.logError(
                    `[${worker.id}] Error`,
                    Cause.squash(exit.cause),
                  );
                }
                return Effect.void;
              }),
              Effect.tap((exit) => Deferred.complete(deferred, exit)),
            ),
        ),
        Stream.runDrain,
        Effect.forkScoped,
        Scope.provide(scope),
      );
      fibers.set(worker.name, { deferred, fiber, hash });
      return yield* Deferred.await(deferred);
    }),
    stop,
  });
});

function bundleOutputToWorkerd(
  bundle: Bundle.BundleOutput,
): Server.WorkerInput["modules"] {
  const modules: Server.WorkerInput["modules"] = [];
  for (const file of bundle.files) {
    if (file.path.endsWith(".map") || file.content instanceof Uint8Array) {
      continue;
    }
    modules.push({
      name: file.path,
      esModule: file.content,
    });
  }
  return modules;
}

const server = SidecarServer.pipe(
  provideLayerScoped(
    Layer.provide(
      Server.layer({ port: 1337, storage: ".alchemy/local" }),
      Layer.merge(FetchHttpClient.layer, Auth.fromEnv()),
    ),
  ),
);

RpcServer.makeRpcServer(server, SidecarSchema).pipe(
  Effect.provide(RpcServer.layerServices(import.meta.url)),
  Effect.provide(PlatformServices),
  Effect.scoped,
  runMain,
);
