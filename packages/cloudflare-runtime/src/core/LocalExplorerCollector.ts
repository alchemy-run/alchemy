import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SystemError } from "./RuntimeError.shared.ts";
import { Workerd } from "./workerd/Workerd.ts";
import type { Service } from "./workerd/Config.ts";

const metadataSchema = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  health: Schema.String,
});
const host = `
import Collector from "./collector.worker.js";
export { TraceStore } from "./collector.worker.js";
export default class extends Collector {
  fetch(request) {
    if (new URL(request.url).pathname === "/health") return Response.json({ id: this.env.COLLECTOR_ID });
    return super.fetch(request);
  }
  tailStream(onset) {
    const handler = super.tailStream(onset);
    // Return an RPC callback instead of serializing the collector's class.
    return (event) => {
      const method = handler[event.event.type];
      if (typeof method === "function") return method.call(handler, event);
    };
  }
}
`;

// Every Worker (including a separate Vite process) uses one live collector.
// A filesystem lease elects the owner; health checks and scoped cleanup let a
// follower take over when the owner exits. Never open the same SQLite actor in
// multiple workerd processes: its local VFS assumes a single actor owner.
export const makeLocalExplorerCollector = Effect.fn("LocalExplorer.collector")(
  function* (storage: Service) {
    const workerd = yield* Workerd;
    const lifetime = yield* Effect.scope;
    const mutex = yield* Semaphore.make(1);
    const storagePath = "disk" in storage ? storage.disk?.path : undefined;
    if (!storagePath)
      return yield* new SystemError({
        subtag: "LocalExplorer",
        message: "Collector requires disk-backed storage.",
      });
    const directory = path.resolve(storagePath, "observability");
    const record = path.join(directory, "collector.json");
    const require = createRequire(import.meta.url);
    const io = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: (cause) =>
          new SystemError({
            subtag: "LocalExplorerCollector",
            message: "Unable to start or locate the local trace collector.",
            cause,
          }),
      });
    yield* io(() => fs.mkdir(directory, { recursive: true }));
    const lockfile: typeof import("proper-lockfile") = require("proper-lockfile");
    let owned: Scope.Closeable | undefined;
    const get = Effect.gen(function* () {
      // The persisted record is only trusted after its live endpoint confirms
      // the random identity, so a reused port cannot select another service.
      const current = yield* io(async () => {
        try {
          const value = Schema.decodeUnknownSync(
            Schema.fromJsonString(metadataSchema),
          )(await fs.readFile(record, "utf8"));
          const response = await fetch(value.health, {
            signal: AbortSignal.timeout(500),
          });
          const health = Schema.decodeUnknownSync(
            Schema.Struct({ id: Schema.String }),
          )(await response.json());
          return response.ok && health.id === value.id ? value : undefined;
        } catch {
          return undefined;
        }
      });
      if (current) return current;
      if (owned) {
        const failed = owned;
        owned = undefined;
        yield* Scope.close(failed, Exit.void);
      }
      const release = yield* Effect.tryPromise({
        try: () =>
          lockfile.lock(directory, {
            realpath: true,
            retries: 0,
            stale: 5000,
            update: 1000,
          }),
        catch: (cause) =>
          new SystemError({
            subtag:
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "ELOCKED"
                ? "CollectorStarting"
                : "LocalExplorerCollector",
            message:
              "The local trace collector is starting or its previous lease is expiring.",
            cause,
          }),
      });
      const scope = yield* Scope.fork(lifetime);
      owned = scope;
      const id = crypto.randomUUID();
      yield* Scope.addFinalizer(
        scope,
        Effect.promise(async () => {
          if (owned === scope) owned = undefined;
          try {
            const value = Schema.decodeUnknownSync(
              Schema.fromJsonString(metadataSchema),
            )(await fs.readFile(record, "utf8"));
            if (value.id === id) await fs.unlink(record);
          } catch (cause) {
            if (
              !(
                cause instanceof Error &&
                "code" in cause &&
                cause.code === "ENOENT"
              )
            )
              console.error(
                "Unable to clean up local collector metadata",
                cause,
              );
          } finally {
            await release();
          }
        }),
      );
      return yield* Effect.gen(function* () {
        const miniflareDist = path.dirname(require.resolve("miniflare"));
        const collector = yield* io(() =>
          fs.readFile(
            path.join(
              miniflareDist,
              "workers/observability/collector.worker.js",
            ),
            "utf8",
          ),
        );
        const ports = yield* workerd.serve(
          {
            sockets: [
              {
                name: "collector",
                address: "127.0.0.1:0",
                service: { name: "local-explorer:collector" },
              },
            ],
            services: [
              { name: "storage", disk: { path: directory, writable: true } },
              {
                name: "local-explorer:collector",
                worker: {
                  compatibilityDate: "2026-01-01",
                  compatibilityFlags: ["nodejs_compat"],
                  modules: [
                    { name: "host.js", esModule: host },
                    { name: "collector.worker.js", esModule: collector },
                  ],
                  durableObjectNamespaces: [
                    {
                      className: "TraceStore",
                      uniqueKey: "miniflare-wobs-trace-store",
                      enableSql: true,
                      preventEviction: true,
                    },
                  ],
                  durableObjectStorage: { localDisk: "storage" },
                  bindings: [
                    {
                      name: "TRACE_STORE",
                      durableObjectNamespace: { className: "TraceStore" },
                    },
                    { name: "COLLECTOR_ID", text: id },
                  ],
                },
              },
            ],
          },
          { "debug-port": "127.0.0.1:0" },
        );
        const value = {
          id,
          address: `127.0.0.1:${ports["debug-port"]}`,
          health: `http://127.0.0.1:${ports.collector}/health`,
        };
        yield* io(async () => {
          const pending = `${record}.${id}`;
          await fs.writeFile(pending, JSON.stringify(value));
          await fs.rename(pending, record);
        });
        return value;
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
    }).pipe(
      mutex.withPermits(1),
      Effect.retry({
        times: 100,
        schedule: Schedule.spaced("100 millis"),
        while: (error) => error.subtag === "CollectorStarting",
      }),
    );
    return { get };
  },
);
