import * as Server from "@distilled.cloud/cloudflare-runtime/server";
import * as Auth from "@distilled.cloud/cloudflare/Auth";
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
import { provideLayerScoped } from "../../Util/layer-scoped.ts";
import { PlatformServices, runMain } from "../../Util/PlatformServices.ts";
import { WorkerBundle } from "../Workers/WorkerBundle.ts";
import { Sidecar, SidecarSchema, type ServeOptions } from "./Sidecar.ts";

const SidecarServer = Effect.gen(function* () {
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

  return Sidecar.of({
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
              Effect.tap((exit) => Deferred.complete(deferred, exit)),
            ),
        ),
        Stream.runDrain,
        Effect.forkScoped,
        Scope.provide(scope),
      );
      fibers.set(worker.name, fiber);
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
