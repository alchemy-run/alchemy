import { loadInternalWorker } from "../internal/internal-worker.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
const IngressWorker = {
  worker: () =>
    loadInternalWorker("#cloudflare-runtime-core-worker/proxy/Ingress.worker"),
};
import * as Internet from "../globals/Internet.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "../internal/constants.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Port from "../internal/Port.ts";
import type { RuntimeError } from "../RuntimeError.shared.ts";
import { ConfigError, SystemError } from "../RuntimeError.shared.ts";
import * as WorkerdConfig from "../workerd/Config.ts";
import * as Workerd from "../workerd/Workerd.ts";
import type { IngressRoute } from "./Ingress.worker.ts";

export type { IngressRoute } from "./Ingress.worker.ts";

/**
 * A host-routing HTTP front door for local dev: every locally served
 * resource is reachable on ONE port as `<name>.<domain>` and the ingress
 * forwards each request to the resource's upstream (typically its stable
 * {@link import("./WorkerProxy.ts").WorkerProxy}). One process-wide instance
 * is served per dev session; routes are added and removed as resources
 * start and stop.
 */
export class Ingress extends Context.Service<
  Ingress,
  {
    readonly serve: (
      options: IngressServeOptions,
    ) => Effect.Effect<IngressInstance, RuntimeError, Scope.Scope>;
  }
>()("cloudflare-runtime/proxy/Ingress") {}

export interface IngressServeOptions {
  /**
   * The port to serve on. When unavailable the next free port is used
   * unless {@link strictPort} is set.
   */
  readonly port: number;
  /**
   * Fail instead of falling back to another port when {@link port} is
   * taken (or privileged and not bindable).
   * @default false
   */
  readonly strictPort?: boolean;
  /**
   * The interface to bind. Defaults to the loopback on both address
   * families (`127.0.0.1` and `[::1]`), so `*.localhost` names resolving to
   * either reach the ingress.
   * @default "127.0.0.1"
   */
  readonly host?: string;
  /** The dev domain route hosts end with (`localhost`, `myapp.test`). */
  readonly domain: string;
}

export interface IngressInstance {
  /** The bare address of the ingress, e.g. `http://localhost:1337/`. */
  readonly url: URL;
  /** The port the ingress ended up on. */
  readonly port: number;
  /**
   * Public identity of this instance, echoed by `/cdn-cgi/ingress/health` —
   * lets a caller verify that some other address (a privileged `:80`
   * forward) lands on THIS ingress.
   */
  readonly id: string;
  /** Add or replace the route for `host` (lower-case hostname, no port). */
  readonly set: (
    host: string,
    route: IngressRoute,
  ) => Effect.Effect<void, SystemError>;
  /** Remove the route for `host` (a no-op when absent). */
  readonly unset: (host: string) => Effect.Effect<void, SystemError>;
  /** Snapshot of every route, keyed by host. */
  readonly routes: () => Effect.Effect<
    Record<string, IngressRoute>,
    SystemError
  >;
}

/** Maximum number of port-collision retries for a single `serve` call (each attempt spawns a workerd process). */
const MAX_SERVE_ATTEMPTS = 8;

/** Whether `port` is reserved for root on Unix (bind needs privileges). */
const isPrivilegedPort = (port: number): boolean =>
  port > 0 && port < 1024 && process.platform !== "win32";

export const IngressLive = Layer.effect(
  Ingress,
  Effect.gen(function* () {
    const workerd = yield* Workerd.Workerd;
    const internet = yield* Internet.Internet;
    const ports = yield* Port.make({ cache: true });

    // See WorkerProxy: `localhost` resolves to both 127.0.0.1 and ::1 and
    // browsers prefer IPv6, so own the port on both families.
    const ipv6Loopback = yield* Effect.callback<boolean>((resume) => {
      const server = NodeNet.createServer();
      server.once("error", () => resume(Effect.succeed(false)));
      server.listen({ port: 0, host: "::1", exclusive: true }, () =>
        server.close(() => resume(Effect.succeed(true))),
      );
      return Effect.sync(() => server.close());
    });

    /**
     * Whether this process may bind `port` on the loopback right now.
     * Distinguishes "privileged / taken" (a `ConfigError`) from the plain
     * availability probe, which folds `EACCES` into "in use".
     */
    const canBind = (port: number, host: string) =>
      Effect.callback<boolean>((resume) => {
        const server = NodeNet.createServer();
        server.once("error", () => {
          server.close(() => resume(Effect.succeed(false)));
        });
        server.listen({ port, host, exclusive: true }, () => {
          server.close(() => resume(Effect.succeed(true)));
        });
        return Effect.sync(() => server.close());
      });

    const normalizeOptions = Effect.fnUntraced(function* (
      options: IngressServeOptions,
    ) {
      const host = options.host ?? "127.0.0.1";
      const strictPort = options.strictPort ?? false;
      let port: number;
      if (isPrivilegedPort(options.port)) {
        // The generic port hunt treats `EACCES` as "in use" and would walk
        // up to 81, 82, … — a privileged port is a deliberate request, so
        // either bind it or fail with a clear error for the caller to
        // explain (and fall back from) explicitly.
        const bindable = yield* canBind(options.port, host);
        if (!bindable) {
          return yield* new ConfigError({
            subtag: "PrivilegedPort",
            message: `Could not bind to port ${options.port} (privileged or already in use).`,
            hint: "Ports below 1024 need elevated privileges; forward the port to the ingress instead or pick a port above 1024.",
            detail: { address: `${host}:${options.port}` },
          });
        }
        port = options.port;
      } else if (strictPort) {
        port = yield* ports.check(options.port);
      } else {
        port = yield* ports
          .waitFor(options.port)
          .pipe(Effect.catch(() => ports.find(options.port)));
      }
      return {
        port,
        host,
        strictPort,
        ipv6: options.host === undefined && ipv6Loopback,
        token: crypto.randomUUID(),
        id: crypto.randomUUID(),
        domain: options.domain,
      };
    });
    type ResolvedOptions = Effect.Success<ReturnType<typeof normalizeOptions>>;

    const modules = yield* Effect.map(
      Effect.promise(IngressWorker.worker),
      formatInternalWorkerModules,
    );

    const serve = ({ host, port, token, id, ipv6, domain }: ResolvedOptions) =>
      workerd
        .serve({
          sockets: [
            {
              name: "http",
              address: `${host}:${port}`,
              service: { name: "ingress:worker" },
            },
            ...(ipv6
              ? [
                  {
                    name: "http-ipv6",
                    address: `[::1]:${port}`,
                    service: { name: "ingress:worker" },
                  },
                ]
              : []),
          ],
          services: [
            {
              name: "ingress:worker",
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                modules,
                bindings: [
                  {
                    name: "INGRESS",
                    durableObjectNamespace: { className: "Ingress" },
                  },
                  { name: "INGRESS_TOKEN", text: token },
                  { name: "INGRESS_ID", text: id },
                  { name: "INGRESS_DOMAIN", text: domain },
                ],
                durableObjectNamespaces: [
                  {
                    className: "Ingress",
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

    const serveWithRetry = (
      options: ResolvedOptions,
      attempt = 1,
    ): ReturnType<typeof serve> =>
      serve(options).pipe(
        Effect.catchIf(
          (error) =>
            Workerd.isAddressInUseError(error) &&
            !options.strictPort &&
            !isPrivilegedPort(options.port) &&
            options.port <= Port.MAX_PORT &&
            attempt < MAX_SERVE_ATTEMPTS,
          () =>
            Effect.flatMap(ports.find(options.port + 1), (port) =>
              serveWithRetry({ ...options, port }, attempt + 1),
            ),
        ),
      );

    const control = (
      url: URL,
      token: string,
      subtag: string,
      path: string,
      init: RequestInit,
    ) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(new URL(`/cdn-cgi/ingress/${path}`, url), {
              ...init,
              headers: {
                ...(init.headers as Record<string, string> | undefined),
                Authorization: `Bearer ${token}`,
              },
            }),
          catch: (cause) =>
            new SystemError({
              subtag,
              message: `Failed to reach the dev ingress at ${url}`,
              cause,
            }),
        });
        if (!response.ok) {
          return yield* new SystemError({
            subtag,
            message: `Dev ingress controller returned ${response.status}`,
            cause: response,
          });
        }
        return response;
      });

    return Ingress.of({
      serve: Effect.fn("Ingress.serve")(function* (options) {
        const resolved = yield* normalizeOptions(options);
        const url = yield* serveWithRetry(resolved);
        const port = Number(url.port);
        if (port !== options.port) {
          yield* Effect.logWarning(
            `Port ${options.port} is in use by another process; serving the dev ingress on ${port} instead. Stop the other process or pass a different --port.`,
          );
        }
        const token = resolved.token;
        return {
          url,
          port,
          id: resolved.id,
          set: Effect.fn("IngressInstance.set")(function* (host, route) {
            yield* control(
              url,
              token,
              "Ingress.set",
              `routes/${encodeURIComponent(host)}`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(route),
              },
            );
          }),
          unset: Effect.fn("IngressInstance.unset")(function* (host) {
            yield* control(
              url,
              token,
              "Ingress.unset",
              `routes/${encodeURIComponent(host)}`,
              { method: "DELETE" },
            );
          }),
          routes: Effect.fn("IngressInstance.routes")(function* () {
            const response = yield* control(
              url,
              token,
              "Ingress.routes",
              "routes",
              {
                method: "GET",
              },
            );
            return (yield* Effect.tryPromise({
              try: () => response.json(),
              catch: (cause) =>
                new SystemError({
                  subtag: "Ingress.routes",
                  message: "Dev ingress returned malformed routes",
                  cause,
                }),
            })) as Record<string, IngressRoute>;
          }),
        };
      }),
    });
  }),
);

/** {@link IngressLive} with its workerd + internet dependencies provided. */
export const layer = () =>
  Layer.provide(
    IngressLive,
    Layer.mergeAll(Internet.InternetLive, Workerd.WorkerdLive),
  );
