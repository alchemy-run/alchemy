import * as Server from "@distilled.cloud/cloudflare-runtime/Server";
import type { WorkerModule } from "@distilled.cloud/cloudflare-runtime/WorkerModule";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as vite from "vite";
import * as Bundle from "../../Bundle/Bundle.ts";
import { WorkerBundle } from "../Workers/WorkerBundle.ts";
import {
  Sidecar,
  type ServeOptions,
  type ServeViteOptions,
} from "./Sidecar.ts";

export const SidecarHandlers = Layer.effect(
  Sidecar,
  Effect.gen(function* () {
    const bundle = yield* WorkerBundle;
    const server = yield* Server.Server;

    const rootScope = yield* Effect.scope;
    const serverScopes = new Map<string, Scope.Closeable>();
    const viteServers = new Map<
      string,
      {
        hash: string;
        address: string;
        server: vite.ViteDevServer;
      }
    >();

    const serveScoped = Effect.fnUntraced(function* (
      worker: ServeOptions,
      modules: WorkerModule[],
    ) {
      const scope = yield* Effect.flatMap(Effect.scope, Scope.fork);
      const result = yield* server
        // The published @distilled.cloud/cloudflare-runtime types don't yet
        // declare `hyperdrives` on the serve options, but the runtime
        // accepts it. Cast through any so dev-mode local DB wiring works
        // until the type is shipped upstream.
        .serve({
          name: worker.id.toLowerCase(),
          compatibilityDate: worker.compatibility.date,
          compatibilityFlags: worker.compatibility.flags,
          bindings: worker.bindings,
          hyperdrives: worker.hyperdrives,
          durableObjectNamespaces: worker.durableObjectNamespaces,
          modules,
        })
        .pipe(Scope.provide(scope));
      const previous = serverScopes.get(worker.name);
      if (previous) {
        yield* Effect.forkDetach(Scope.close(previous, Exit.void));
      }
      serverScopes.set(worker.name, scope);
      return result;
    });

    const closeViteServer = (name: string) =>
      Effect.gen(function* () {
        const existing = viteServers.get(name);
        if (!existing) return;
        viteServers.delete(name);
        yield* Effect.tryPromise({
          try: () => existing.server.close(),
          catch: (cause) =>
            new Bundle.BundleError({
              message: `Failed to stop Vite dev server for ${name}`,
              cause,
            }),
        });
      });

    const serveVite = Effect.fnUntraced(function* (worker: ServeViteOptions) {
      const existing = viteServers.get(worker.name);
      if (existing?.hash === worker.configHash) {
        yield* Effect.log(`[${worker.id}] No Vite config changes`);
        return { name: worker.name, address: existing.address };
      }

      yield* closeViteServer(worker.name);

      const server = yield* Effect.tryPromise({
        try: async () => {
          const vite = await loadVite(worker.rootDir);
          const previousConfigPath =
            process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
          process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH =
            worker.wranglerConfigPath;
          try {
            const server = await vite.createServer({
              root: worker.rootDir,
              clearScreen: false,
              server: {
                host: "127.0.0.1",
                port: 0,
              },
            });
            await server.listen();
            server.printUrls();
            return server;
          } finally {
            if (previousConfigPath === undefined) {
              delete process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH;
            } else {
              process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH =
                previousConfigPath;
            }
          }
        },
        catch: (cause) =>
          new Bundle.BundleError({
            message: `Failed to start Vite dev server for ${worker.name}`,
            cause,
          }),
      });
      const address =
        server.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ??
        `http://127.0.0.1:${server.config.server.port}`;
      viteServers.set(worker.name, {
        hash: worker.configHash,
        address,
        server,
      });
      yield* Effect.log(`[${worker.id}] Vite dev server started at ${address}`);
      return { name: worker.name, address };
    });

    const watchers = new Map<
      string,
      {
        hash: number;
        fiber: Fiber.Fiber<
          Server.ServeResult,
          Server.ServeError | Bundle.BundleError
        >;
        scope: Scope.Closeable;
      }
    >();

    const serveFiber = Effect.fnUntraced(function* (worker: ServeOptions) {
      const result = yield* Deferred.make<
        Server.ServeResult,
        Server.ServeError | Bundle.BundleError
      >();
      let start = Date.now();
      yield* bundle.watch(worker).pipe(
        Stream.mapEffect((event) =>
          event._tag === "Error" && !Deferred.isDoneUnsafe(result)
            ? Effect.fail(event.error)
            : Effect.succeed(event),
        ),
        Stream.tap((event) => {
          if (event._tag === "Start") {
            start = Date.now();
            if (Deferred.isDoneUnsafe(result)) {
              return Effect.log(`[${worker.id}] Rebuilding`);
            }
          } else if (event._tag === "Error") {
            return Effect.logError(`[${worker.id}] Bundle error`, event.error);
          }
          return Effect.void;
        }),
        Stream.filterMap((event) =>
          event._tag === "Success"
            ? Result.succeed(event.output)
            : Result.failVoid,
        ),
        Stream.map(bundleOutputToWorkerModules),
        Stream.mapEffect((modules) =>
          serveScoped(worker, modules).pipe(
            Effect.exit,
            Effect.tap((exit) => {
              const isDone = Deferred.isDoneUnsafe(result);
              if (exit._tag === "Success") {
                return Effect.log(
                  `[${worker.id}] ${isDone ? "Updated" : "Started"} in ${Math.round(Date.now() - start)}ms`,
                );
              } else if (isDone) {
                return Effect.logError(
                  `[${worker.id}] Error`,
                  Cause.squash(exit.cause),
                );
              }
              return Effect.void;
            }),
            Effect.tap((exit) => Deferred.complete(result, exit)),
          ),
        ),
        Stream.onExit((exit) =>
          exit._tag === "Failure" && !Deferred.isDoneUnsafe(result)
            ? Deferred.failCause(result, exit.cause)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      return yield* Deferred.await(result);
    });

    return Sidecar.of({
      serve: Effect.fn(function* (worker: ServeOptions) {
        const hash = Hash.structure(worker);
        const existing = watchers.get(worker.name);
        if (existing) {
          if (existing.hash === hash) {
            yield* Effect.log(
              `[${worker.id}] No changes, using existing watcher`,
            );
            return yield* Fiber.join(existing.fiber);
          }
          yield* Effect.log(
            `[${worker.id}] Changes detected, interrupting existing watcher`,
          );
          yield* Fiber.interrupt(existing.fiber);
          yield* Scope.close(existing.scope, Exit.void);
          watchers.delete(worker.name);
        }
        const scope = yield* Scope.fork(rootScope);
        const fiber = yield* serveFiber(worker).pipe(
          Effect.forkDetach,
          Scope.provide(scope),
        );
        watchers.set(worker.name, { hash, fiber, scope });
        return yield* Fiber.join(fiber).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (exit._tag === "Failure") {
                watchers.delete(worker.name);
              }
            }),
          ),
        );
      }),
      serveVite,
      stop: Effect.fn(function* (name: string) {
        yield* closeViteServer(name).pipe(Effect.ignore);
        const watcher = watchers.get(name);
        if (watcher) {
          yield* Fiber.interrupt(watcher.fiber);
          yield* Scope.close(watcher.scope, Exit.void);
          watchers.delete(name);
        }
      }),
    });
  }),
);

function bundleOutputToWorkerModules(
  bundle: Bundle.BundleOutput,
): WorkerModule[] {
  const modules: WorkerModule[] = [];
  for (const file of bundle.files) {
    if (file.path.endsWith(".map") || file.content instanceof Uint8Array) {
      continue;
    }
    modules.push({
      name: file.path,
      type: "ESModule",
      content: file.content,
    });
  }
  return modules;
}

type ViteModule = typeof import("vite");

async function loadVite(projectRoot: string): Promise<ViteModule> {
  try {
    const require = createRequire(path.join(projectRoot, "package.json"));
    const vitePath = require.resolve("vite");
    const viteUrl = pathToFileURL(vitePath);
    return await import(/* @vite-ignore */ viteUrl.href);
  } catch {
    return await import("vite");
  }
}
