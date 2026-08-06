import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ProxyWorker from "worker:./WorkerProxy.worker.ts";
import * as Internet from "../globals/Internet.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Port from "../internal/Port.ts";
import type { RuntimeError } from "../RuntimeError.shared.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as Workerd from "../workerd/Workerd.ts";

export class WorkerProxy extends Context.Service<
  WorkerProxy,
  {
    readonly serve: (
      options?: ServeOptions,
    ) => Effect.Effect<WorkerProxyInstance, RuntimeError, Scope.Scope>;
  }
>()("cloudflare-runtime/proxy/WorkerProxy") {}

export interface ServeOptions {
  /**
   * The port to serve the proxy on. If not provided, a random port will be chosen.
   * @default 0
   */
  readonly port?: number;
  /**
   * Whether to throw an error if the port is not available.
   * @default false
   */
  readonly strictPort?: boolean;
  /**
   * The host to serve the proxy on.
   * @default "localhost"
   */
  readonly host?: string;
}

/** Maximum number of port-collision retries for a single `serve` call (each attempt spawns a workerd process). */
const MAX_SERVE_ATTEMPTS = 8;

export interface WorkerProxyInstance {
  readonly url: URL;
  readonly set: (upstream: URL) => Effect.Effect<void, SystemError>;
  readonly unset: () => Effect.Effect<void, SystemError>;
}

export const WorkerProxyLive = Layer.effect(
  WorkerProxy,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const internet = yield* Internet.Internet;
    const ports = yield* Port.make({ cache: true });

    const normalizeOptions = Effect.fnUntraced(function* (
      options: ServeOptions,
    ) {
      const host = options.host ?? "127.0.0.1";
      const strictPort = options.strictPort ?? false;
      return {
        port:
          options.port && options.strictPort
            ? yield* ports.check(options.port)
            : yield* ports.find(options.port ?? 0),
        host,
        strictPort,
        token: crypto.randomUUID(),
      };
    });
    type ResolvedOptions = Effect.Success<ReturnType<typeof normalizeOptions>>;

    const modules = yield* Effect.map(
      Effect.promise(ProxyWorker.worker),
      formatInternalWorkerModules,
    );

    const serve = ({ host, port, token }: ResolvedOptions) =>
      workerd
        .serve({
          sockets: [
            {
              name: "http",
              address: `${host}:${port}`,
              service: { name: "proxy:worker" },
            },
          ],
          services: [
            {
              name: "proxy:worker",
              worker: {
                compatibilityDate: "2026-03-10",
                modules,
                bindings: [
                  {
                    name: "PROXY",
                    durableObjectNamespace: { className: "WorkerProxy" },
                  },
                  { name: "PROXY_TOKEN", text: token },
                ],
                durableObjectNamespaces: [
                  {
                    className: "WorkerProxy",
                    ephemeralLocal: WorkerdConfig.kVoid,
                    preventEviction: true,
                  },
                ],
              },
            },
            internet,
          ],
        })
        .pipe(
          Effect.map(
            (ports) =>
              new URL(
                `http://${host === "127.0.0.1" ? "localhost" : host}:${ports.http}`,
              ),
          ),
        );

    // The `findAvailablePort` function is lower overhead than `serve`, but it's best-effort.
    // If there is a race condition, we may not be able to bind to the port, so we retry.
    // The retry MUST be bounded: every attempt spawns a fresh workerd process, and on
    // Windows `isAddressInUseError` matches any `std::terminate` start crash — an
    // environmental failure (e.g. socket-buffer exhaustion on CI) would otherwise turn
    // this into an unbounded workerd-spawn storm that amplifies the exhaustion.
    const serveWithRetry = (
      options: Parameters<typeof serve>[0],
      attempt = 1,
    ): ReturnType<typeof serve> =>
      serve(options).pipe(
        Effect.catchIf(
          (error) =>
            Workerd.isAddressInUseError(error) &&
            !options.strictPort &&
            options.port <= Port.MAX_PORT &&
            attempt < MAX_SERVE_ATTEMPTS,
          () =>
            Effect.flatMap(ports.find(options.port + 1), (port) =>
              serveWithRetry({ ...options, port }, attempt + 1),
            ),
        ),
      );

    return WorkerProxy.of({
      serve: Effect.fn("WorkerProxy.serve")(function* (options = {}) {
        const resolved = yield* normalizeOptions(options);
        const url = yield* serveWithRetry(resolved);
        return {
          url,
          set: Effect.fn("WorkerProxyInstance.set")(function* (upstream) {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/cdn-cgi/proxy/controller", url), {
                method: "PUT",
                headers: {
                  "Content-Type": "text/plain",
                  Authorization: `Bearer ${resolved.token}`,
                },
                body: upstream.toString(),
              }),
            );
            if (!response.ok) {
              return yield* new SystemError({
                subtag: "WorkerProxy.set",
                message: "Failed to set upstream",
                cause: response,
              });
            }
          }),
          unset: Effect.fn("WorkerProxyInstance.unset")(function* () {
            const response = yield* Effect.promise(() =>
              fetch(new URL("/cdn-cgi/proxy/controller", url), {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${resolved.token}`,
                },
              }),
            );
            if (!response.ok) {
              return yield* new SystemError({
                subtag: "WorkerProxy.unset",
                message: "Failed to unset upstream",
                cause: response,
              });
            }
          }),
        };
      }),
    });
  }),
);
