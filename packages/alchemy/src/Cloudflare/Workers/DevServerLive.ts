import * as Server from "@distilled.cloud/cloudflare-runtime/server";
import * as Auth from "@distilled.cloud/cloudflare/Auth";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as Bundle from "../../Bundle/Bundle.ts";
import * as RpcServer from "../../Sidecar/RpcServer.ts";
import { PlatformServices } from "../../Util/PlatformServices.ts";
import {
  DevServerSchema,
  type DevServer,
  type ServeOptions,
} from "./DevServer.ts";
import { WorkerBundle } from "./WorkerBundle.ts";

const DevServerLive = Effect.gen(function* () {
  const server = yield* Server.Server;
  const fibers = new Map<
    string,
    Fiber.Fiber<void, Server.ServeError | Bundle.BundleError>
  >();
  const scope = yield* Effect.scope;
  const bundle = yield* WorkerBundle;

  const stop = Effect.fn(function* (name: string) {
    yield* server.stop(name);
    const fiber = fibers.get(name);
    if (fiber) {
      yield* Fiber.interrupt(fiber);
      fibers.delete(name);
    }
  });

  return {
    serve: Effect.fn(function* (worker: ServeOptions) {
      yield* stop(worker.name);
      const deferred = yield* Deferred.make<
        Server.ServeResult,
        Server.ServeError
      >();
      const fiber = yield* bundle.watch(worker).pipe(
        Stream.filterMap(identity),
        Stream.map(bundleOutputToWorkerd),
        Stream.mapEffect((modules) =>
          server
            .start({
              name: worker.name,
              accountId: worker.accountId,
              compatibilityDate: worker.compatibility.date,
              compatibilityFlags: worker.compatibility.flags,
              bindings: worker.bindings,
              durableObjectNamespaces: worker.durableObjectNamespaces,
              modules,
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) => Deferred.complete(deferred, exit)),
            ),
        ),
        Stream.runDrain,
        Effect.forkScoped,
        Scope.provide(scope),
      );
      fibers.set(worker.name, fiber);
      const result = yield* Deferred.await(deferred);
      console.log("result", result);
      return result;
    }),
    stop,
  } satisfies DevServer;
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

const services = Layer.provideMerge(
  Layer.merge(
    Layer.provide(
      Server.layer({ port: 1337, storage: ".alchemy/local" }),
      Layer.merge(FetchHttpClient.layer, Auth.fromEnv()),
    ),
    RpcServer.layerServices(import.meta.url),
  ),
  PlatformServices,
);

DevServerLive.pipe(
  Effect.flatMap((handlers) =>
    RpcServer.makeRpcServer(handlers, DevServerSchema),
  ),
  Effect.provide(services),
  Effect.scoped,
  NodeRuntime.runMain,
);
