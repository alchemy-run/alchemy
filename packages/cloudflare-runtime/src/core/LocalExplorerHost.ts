import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Loopback } from "./globals/Loopback.ts";
import type { PluginContext } from "./PluginContext.ts";
import { RegistryProxy } from "./registry/RegistryProxy.ts";
import { SystemError } from "./RuntimeError.shared.ts";
import { kVoid, type Service } from "./workerd/Config.ts";
import { Workerd } from "./workerd/Workerd.ts";

const metadata = Schema.Struct({ id: Schema.String, port: Schema.Number });
const prefix = "/cdn-cgi/local/explorer";
const host = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/_alchemy/explorer/health") return Response.json({ id: env.ID });
    if (url.pathname === "/") return Response.redirect(new URL("${prefix}/", url), 302);
    if (url.pathname !== "${prefix}" && !url.pathname.startsWith("${prefix}/")) return new Response("Not found", { status: 404 });
    const response = await env.REGISTRY.fetch("http://localhost/");
    const peers = await response.json();
    // Probe before forwarding. Never retry the user's request: it may mutate
    // storage even if the connection fails before a response arrives.
    for (const peer of peers) {
      const entry = env.DEBUG.connect(peer.debugPortAddress).getEntrypoint("core:entry");
      try {
        const health = await entry.fetch("http://localhost/_alchemy/explorer/health");
        if (!health.ok || (await health.json()).id !== peer.localExplorer.instanceId) continue;
      } catch { continue; }
      return entry.fetch(request);
    }
    return new Response("Local Workers are starting. Please retry shortly.", { status: 503, headers: { "Retry-After": "1" } });
  }
};
`;

// One browser endpoint per storage directory, shared by separate CLI/Vite
// processes. Its lifetime is the Runtime layer, not an individual Worker.
// Followers take over the same port when the owning process exits.
export const makeLocalExplorerHost = Effect.fn("LocalExplorer.host")(function* (
  storage: Service,
  context: PluginContext["Service"],
) {
  const workerd = yield* Workerd;
  const lifetime = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  const storagePath = "disk" in storage ? storage.disk?.path : undefined;
  if (!storagePath)
    return yield* new SystemError({
      subtag: "LocalExplorer",
      message: "Local Explorer requires disk-backed storage.",
    });
  const storageScope = path.resolve(storagePath);
  const directory = path.join(storageScope, "local-explorer");
  const record = path.join(directory, "host.json");
  const io = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) =>
        new SystemError({
          subtag: "LocalExplorerHost",
          message: "Unable to start or locate Local Explorer.",
          cause,
        }),
    });
  yield* io(() => fs.mkdir(directory, { recursive: true }));
  const loopback = yield* context.get(Loopback);
  const registry = yield* context.get(RegistryProxy);
  const registryBinding = yield* loopback.api.route(
    `explorer-host:${crypto.randomUUID()}`,
    async (_request, response) => {
      const entries = await Effect.runPromise(
        registry.api.localExplorerEntries,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          entries
            .filter(
              (entry) => entry.localExplorer?.storageScope === storageScope,
            )
            .sort((a, b) => a.scriptName.localeCompare(b.scriptName)),
        ),
      );
    },
    lifetime,
  );
  const lockfile: typeof import("proper-lockfile") = createRequire(
    import.meta.url,
  )("proper-lockfile");
  let owned: Scope.Closeable | undefined;
  const get = Effect.gen(function* () {
    const previous = yield* io(async () => {
      try {
        return Schema.decodeUnknownSync(Schema.fromJsonString(metadata))(
          await fs.readFile(record, "utf8"),
        );
      } catch {
        return undefined;
      }
    });
    if (previous) {
      const alive = yield* io(async () => {
        try {
          const response = await fetch(
            `http://127.0.0.1:${previous.port}/_alchemy/explorer/health`,
            { signal: AbortSignal.timeout(500) },
          );
          return (
            response.ok &&
            Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
              await response.json(),
            ).id === previous.id
          );
        } catch {
          return false;
        }
      });
      if (alive) return `http://127.0.0.1:${previous.port}${prefix}/`;
    }
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
              ? "ExplorerStarting"
              : "LocalExplorerHost",
          message:
            "Local Explorer is starting or its previous lease is expiring.",
          cause,
        }),
    });
    const scope = yield* Scope.fork(lifetime);
    owned = scope;
    yield* Scope.addFinalizer(
      scope,
      Effect.promise(() => release()),
    );
    return yield* Effect.gen(function* () {
      const id = crypto.randomUUID();
      const ports = yield* workerd.serve({
        sockets: [
          {
            name: "explorer",
            address: `127.0.0.1:${previous?.port ?? 0}`,
            service: { name: "explorer-host" },
          },
        ],
        services: [
          ...(loopback.services ?? []),
          {
            name: "explorer-host",
            worker: {
              compatibilityDate: "2026-01-01",
              modules: [{ name: "host.js", esModule: host }],
              bindings: [
                { name: "ID", text: id },
                { name: "DEBUG", workerdDebugPort: kVoid },
                { name: "REGISTRY", service: registryBinding },
              ],
            },
          },
        ],
      });
      const port = ports.explorer;
      yield* io(async () => {
        const pending = `${record}.${id}`;
        await fs.writeFile(pending, JSON.stringify({ id, port }));
        await fs.rename(pending, record);
      });
      const url = `http://127.0.0.1:${port}${prefix}/`;
      yield* Effect.logInfo(`Local Explorer: ${url}`);
      return url;
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
  }).pipe(
    mutex.withPermits(1),
    Effect.retry({
      times: 100,
      schedule: Schedule.spaced("100 millis"),
      while: (error) => error.subtag === "ExplorerStarting",
    }),
  );
  const url = yield* get;
  yield* get.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Local Explorer host unavailable", error),
    ),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped,
  );
  return url;
});
