import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as LogLevel from "effect/LogLevel";
import * as Logger from "effect/Logger";
import * as http from "node:http";
import { Service } from "../../bindings/index.ts";
import * as RemoteBindings from "../../remote-bindings/RemoteBindings.ts";
import * as RemoteWorker from "../../remote-bindings/RemoteWorker.ts";
import type {
  RemoteBinding,
  RemoteWorkerConfig,
} from "../../remote-bindings/RemoteWorkerConfig.shared.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

/**
 * Regression spec for remote bindings being spread across per-worker proxy
 * scripts (reported as: a Vectorize index bound as `VECTORS` by one worker and
 * as `Vectors` by another — same index — made *every* call from the first
 * worker fail with `Binding "VECTORS" not found in remote worker bindings`,
 * while the second worker's calls succeeded).
 *
 * Cloudflare's edge preview is scoped to the **account subdomain**, not to the
 * uploaded script: several previews deployed for one account collapse onto a
 * single live script, and every preview URL — presented with its own
 * `cf-workers-preview-token` — then serves whichever upload survived. Measured
 * against the real API with three previews from one `alchemy dev` session, each
 * queried on its own hostname with its own token: all three answered as the
 * last-uploaded script, so a worker asking for a binding the survivor does not
 * carry got `BindingNotFound` from a proxy whose own upload metadata listed
 * exactly that binding.
 *
 * The fix is to union every worker's remote bindings onto ONE proxy script, so
 * whichever upload survives the collapse carries all of them. The proxy-side
 * binding name is namespaced per worker (`w<hash>_NAME`) — that name is a free
 * variable, chosen by `register`, sent by the client as `MF-Binding` and looked
 * up by the proxy as `env[thatString]` — so two workers may bind **different**
 * resources under the **same** user-facing name without cross-wiring.
 *
 * {@link startFakeEdge} below models the collapse exactly — one script per
 * account, replaced wholesale by each deploy — so the spec is deterministic and
 * needs no Cloudflare account.
 */

interface EdgeState {
  /** every config `RemoteWorker.deploy` was called with, in order */
  deploys: Array<RemoteWorkerConfig>;
  /** base URL of the fake edge server */
  edgeUrl: string;
  /**
   * The ONE script live at the account's preview subdomain, as a map from the
   * binding name it was uploaded under to the resource that binding points at.
   * Each deploy replaces it wholesale — that is the collapse.
   */
  live: Map<string, string>;
  /** every log record emitted while the case ran */
  logs: Array<{ level: LogLevel.LogLevel; message: string }>;
}

const state: EdgeState = {
  deploys: [],
  edgeUrl: "",
  live: new Map(),
  logs: [],
};

const resetState = Effect.sync(() => {
  state.deploys = [];
  state.edgeUrl = "";
  state.live = new Map();
  state.logs = [];
});

/** Which underlying resource a remote binding points at, ignoring its name. */
const resourceOf = (binding: RemoteBinding): string =>
  (binding as { service?: string }).service ?? "unknown";

/**
 * Stand-in for the real `RemoteWorker` (which would create a Cloudflare preview
 * session and upload the proxy script). Records the config it is handed and
 * makes its bindings the live script, mirroring the account-scoped collapse.
 */
const StubRemoteWorker = Layer.succeed(
  RemoteWorker.RemoteWorker,
  RemoteWorker.RemoteWorker.of({
    deploy: (config) =>
      Effect.sync(() => {
        state.deploys.push(config);
        state.live = new Map(
          config.bindings.map((binding) => [binding.name, resourceOf(binding)]),
        );
        return {
          url: state.edgeUrl,
          headers: {
            "cf-workers-preview-token": `token-${state.deploys.length}`,
          },
        };
      }),
  }),
);

/**
 * Fake preview edge, standing in for `remote.worker.ts`: it looks the requested
 * binding up on the currently live script (`env[bindingName]`) and 400s with
 * the same wording when the lookup misses. On a hit it answers with the
 * *resource* that binding resolved to, which is what makes cross-wiring
 * visible. The body deliberately avoids the stale-session markers ("Invalid
 * Workers Preview configuration", "error code: 1031", and our own
 * `BindingNotFound` `ConfigError` shape) so the proxy passes it straight
 * through instead of re-deploying.
 */
const startFakeEdge = Effect.acquireRelease(
  Effect.callback<http.Server>((resume) => {
    const server = http.createServer((req, res) => {
      const binding = req.headers["mf-binding"];
      const resource =
        typeof binding === "string" ? state.live.get(binding) : undefined;
      if (resource !== undefined) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`bound:${resource}`);
      } else {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(
          `Binding "${String(binding)}" not found in remote worker bindings.`,
        );
      }
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      // Block body on purpose: `Effect.callback` reads a returned value as the
      // finalizer, and `server.close()` returns the server itself.
      server.close(() => resume(Effect.void));
    }),
).pipe(
  Effect.tap((server) =>
    Effect.sync(() => {
      const address = server.address() as { port: number };
      state.edgeUrl = `http://127.0.0.1:${address.port}`;
    }),
  ),
);

const script = (binding: string) => `
export default {
  async fetch(request, env) {
    const upstream = await env[${JSON.stringify(binding)}].fetch("http://example.com/ping");
    return new Response(await upstream.text(), { status: upstream.status });
  }
};
`;

/**
 * A worker that reaches a deployed worker through a remote binding of its own
 * choosing. Both halves vary across the cases below: the two callers may
 * disagree on the *name* for one resource, or agree on a name for two
 * *different* resources.
 */
const startWorkerWithRemoteBinding = (
  name: string,
  binding: string,
  service: string,
) =>
  startTestWorker({
    name,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    bindings: [Service.remote(binding, service)],
    modules: [{ name: "main.js", type: "ESModule", content: script(binding) }],
  });

/**
 * The same worker after the user deletes its last remote binding: same name,
 * still started by the runtime, but registering nothing. Its `defer` still
 * runs — every plugin in the context is instantiated for every worker — so
 * `build` is called with an empty binding set, which is the path under test.
 */
const startWorkerWithoutRemoteBindings = (name: string) =>
  startTestWorker({
    name,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    bindings: [],
    modules: [
      {
        name: "main.js",
        type: "ESModule",
        content: `export default { async fetch() { return new Response("ok"); } };`,
      },
    ],
  });

const fetchBody = (worker: {
  fetch: (path: string) => Effect.Effect<Response>;
}) =>
  worker.fetch("/").pipe(
    Effect.flatMap((response) =>
      Effect.promise(async () => ({
        status: response.status,
        body: await response.text(),
      })),
    ),
  );

/**
 * Proxy-side binding names are namespaced per worker. The hash is an
 * implementation detail, so the assertions below go through these helpers
 * rather than hard-coding it — while still requiring that the namespacing is
 * actually there, since that is what prevents the cross-wiring.
 */
const NAMESPACED = /^w[0-9a-z]+_/;

const userFacingNames = (config: RemoteWorkerConfig) =>
  config.bindings.map((binding) => binding.name.replace(NAMESPACED, "")).sort();

const expectNamespacedAndDistinct = (config: RemoteWorkerConfig) => {
  for (const binding of config.bindings) {
    expect(binding.name).toMatch(NAMESPACED);
  }
  const proxyNames = new Set(config.bindings.map((binding) => binding.name));
  expect(proxyNames.size).toBe(config.bindings.length);
};

const warnings = () =>
  state.logs.filter((log) => log.level === "Warn").map((log) => log.message);

/**
 * Captures log records so the aliasing warning can be asserted. Provided per
 * test effect: the warning is emitted from the plugin's `defer`, which runs
 * inline while the worker starts, so it inherits this fiber's loggers.
 */
const captureLogs = Logger.layer([
  Logger.make((options) => {
    const parts = Array.isArray(options.message)
      ? options.message
      : [options.message];
    state.logs.push({
      level: options.logLevel,
      message: parts
        .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
        .join(" "),
    });
  }),
]);

const testLayer = RemoteBindings.RemoteBindingsLive.pipe(
  Layer.provide(StubRemoteWorker),
  Layer.provideMerge(localRuntimeLayer),
);

// Each `layer(...)` block builds its own `RemoteBindingsLive`, so the shared
// binding set does not leak between the cases below.

layer(testLayer, { excludeTestServices: true })(
  "RemoteBindings shared proxy",
  (it) => {
    it.effect(
      "deploys every worker's remote bindings onto a single proxy script",
      () =>
        Effect.gen(function* () {
          yield* resetState;
          yield* startFakeEdge;

          // Same Vectorize index, two workers, two names: a TanStack site
          // binding it through `env` as `VECTORS`, an Effect worker binding it
          // through `Cloudflare.Vectorize.SearchIndex` (which names it after
          // the logical id, `Vectors`).
          const site = yield* startWorkerWithRemoteBinding(
            "shared-proxy-site",
            "VECTORS",
            "index",
          );
          yield* startWorkerWithRemoteBinding(
            "shared-proxy-ingest",
            "Vectors",
            "index",
          );

          // Nothing is uploaded while workers are still starting: the union is
          // not complete until every worker has built, and racing concurrent
          // uploads is what collapsed them onto each other in the first place.
          expect(state.deploys).toHaveLength(0);

          const response = yield* fetchBody(site);
          expect(response.status).toBe(200);
          expect(response.body).toBe("bound:index");

          // One upload, carrying BOTH workers' bindings.
          expect(state.deploys).toHaveLength(1);
          expect(userFacingNames(state.deploys[0])).toEqual([
            "VECTORS",
            "Vectors",
          ]);
          expectNamespacedAndDistinct(state.deploys[0]);
        }).pipe(Effect.scoped, Effect.provide(captureLogs)),
      { timeout: 30_000 },
    );
  },
);

layer(testLayer, { excludeTestServices: true })(
  "RemoteBindings shared proxy (collapse)",
  (it) => {
    it.effect(
      "keeps every worker working when the account's preview scripts collapse into one",
      () =>
        Effect.gen(function* () {
          yield* resetState;
          yield* startFakeEdge;

          const site = yield* startWorkerWithRemoteBinding(
            "collapse-site",
            "VECTORS",
            "index",
          );
          const ingest = yield* startWorkerWithRemoteBinding(
            "collapse-ingest",
            "Vectors",
            "index",
          );

          // The site is first to use its binding, so its proxy is uploaded
          // first.
          const first = yield* fetchBody(site);
          expect(first.status).toBe(200);
          expect(first.body).toBe("bound:index");

          // The other worker uploads next and, because the preview is scoped to
          // the account subdomain rather than to the script, its upload is now
          // the ONLY script live for both of them.
          const other = yield* fetchBody(ingest);
          expect(other.status).toBe(200);
          expect(other.body).toBe("bound:index");

          // ...which is where the reported failure surfaced: the site's proxy
          // session is cached and still points at a live script it did not
          // upload. That script must still carry the site's binding.
          const second = yield* fetchBody(site);
          expect(second.status, `site lost its binding: ${second.body}`).toBe(
            200,
          );
          expect(second.body).toBe("bound:index");

          // Whichever upload wins the collapse, it carries the union.
          for (const deploy of state.deploys) {
            expect(userFacingNames(deploy)).toEqual(["VECTORS", "Vectors"]);
            expectNamespacedAndDistinct(deploy);
          }
        }).pipe(Effect.scoped, Effect.provide(captureLogs)),
      { timeout: 30_000 },
    );
  },
);

layer(testLayer, { excludeTestServices: true })(
  "RemoteBindings shared proxy (same name)",
  (it) => {
    it.effect(
      "keeps two workers apart when they bind different resources under the same name",
      () =>
        Effect.gen(function* () {
          yield* resetState;
          yield* startFakeEdge;

          // `DB` in one worker and `DB` in another are simply two different
          // resources that happen to share a conventional name — ordinary in a
          // multi-worker stack, and the reason the proxy-side name is
          // namespaced rather than taken verbatim from the user.
          const orders = yield* startWorkerWithRemoteBinding(
            "same-name-orders",
            "DB",
            "orders-db",
          );
          const analytics = yield* startWorkerWithRemoteBinding(
            "same-name-analytics",
            "DB",
            "analytics-db",
          );

          // Neither worker is rejected, and neither reaches the other's
          // resource.
          const fromOrders = yield* fetchBody(orders);
          expect(
            fromOrders.status,
            `orders worker failed: ${fromOrders.body}`,
          ).toBe(200);
          expect(fromOrders.body).toBe("bound:orders-db");

          const fromAnalytics = yield* fetchBody(analytics);
          expect(
            fromAnalytics.status,
            `analytics worker failed: ${fromAnalytics.body}`,
          ).toBe(200);
          expect(fromAnalytics.body).toBe("bound:analytics-db");

          // Both live on the one proxy script, under the same user-facing name
          // but distinct namespaced names — which is what keeps them apart.
          const deploy = state.deploys.at(-1)!;
          expect(userFacingNames(deploy)).toEqual(["DB", "DB"]);
          expectNamespacedAndDistinct(deploy);
          expect(deploy.bindings.map(resourceOf).sort()).toEqual([
            "analytics-db",
            "orders-db",
          ]);

          // Two names for one resource is worth a warning; one name for two
          // resources is not, and must not raise a false alarm.
          expect(
            warnings().filter((message) =>
              message.includes("two different names"),
            ),
          ).toEqual([]);

          // The orders worker still reaches its own resource after the
          // analytics worker's upload replaced the live script.
          const again = yield* fetchBody(orders);
          expect(
            again.status,
            `orders worker lost its binding: ${again.body}`,
          ).toBe(200);
          expect(again.body).toBe("bound:orders-db");
        }).pipe(Effect.scoped, Effect.provide(captureLogs)),
      { timeout: 30_000 },
    );
  },
);

layer(testLayer, { excludeTestServices: true })(
  "RemoteBindings shared proxy (aliasing)",
  (it) => {
    it.effect(
      "warns once when one resource is bound under two different names",
      () =>
        Effect.gen(function* () {
          yield* resetState;
          yield* startFakeEdge;

          // The condition that kept the collapse hidden for so long: while the
          // two names agreed, landing on another worker's proxy still found the
          // binding, so the bug only showed up once they diverged.
          const site = yield* startWorkerWithRemoteBinding(
            "alias-site",
            "VECTORS",
            "shared-index",
          );
          const ingest = yield* startWorkerWithRemoteBinding(
            "alias-ingest",
            "Vectors",
            "shared-index",
          );

          // Aliasing is legal — both workers work.
          const fromSite = yield* fetchBody(site);
          expect(fromSite.status, `site worker failed: ${fromSite.body}`).toBe(
            200,
          );
          expect(fromSite.body).toBe("bound:shared-index");

          const fromIngest = yield* fetchBody(ingest);
          expect(
            fromIngest.status,
            `ingest worker failed: ${fromIngest.body}`,
          ).toBe(200);
          expect(fromIngest.body).toBe("bound:shared-index");

          // ...but it is warned about, exactly once, naming both spellings and
          // the workers they came from.
          const aliasWarnings = warnings().filter((message) =>
            message.includes("two different names"),
          );
          expect(aliasWarnings).toHaveLength(1);
          expect(aliasWarnings[0]).toContain(`"VECTORS"`);
          expect(aliasWarnings[0]).toContain(`"Vectors"`);
          expect(aliasWarnings[0]).toContain("alias-site");
          expect(aliasWarnings[0]).toContain("alias-ingest");
        }).pipe(Effect.scoped, Effect.provide(captureLogs)),
      { timeout: 30_000 },
    );
  },
);

layer(testLayer, { excludeTestServices: true })(
  "RemoteBindings shared proxy (removal)",
  (it) => {
    it.effect(
      "drops a worker's bindings from the union once it rebuilds with none left",
      () =>
        Effect.gen(function* () {
          yield* resetState;
          yield* startFakeEdge;

          // Unioning the bindings is what makes removal matter. Upstream held
          // no state at all, so a deleted binding simply stopped being
          // deployed; here the union outlives any one worker's build, and a
          // worker that restarts without its last remote binding has to
          // actively withdraw from it. It cannot merely be skipped: the union
          // uploads as a single metadata blob, so one binding whose resource is
          // gone fails the upload for *every* worker on the proxy.
          const site = yield* startWorkerWithRemoteBinding(
            "removal-site",
            "VECTORS",
            "site-index",
          );

          // The worker that will lose its binding runs in its own scope, so it
          // is shut down before its replacement starts under the same name —
          // which is what `LocalWorkerProvider` does when a binding edit
          // restarts a worker mid-session.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const ingest = yield* startWorkerWithRemoteBinding(
                "removal-ingest",
                "DB",
                "ingest-db",
              );
              const before = yield* fetchBody(ingest);
              expect(
                before.status,
                `ingest worker failed: ${before.body}`,
              ).toBe(200);
              expect(before.body).toBe("bound:ingest-db");
            }),
          );

          // Both workers are on the one proxy script at this point.
          expect(state.deploys).toHaveLength(1);
          expect(userFacingNames(state.deploys[0])).toEqual(["DB", "VECTORS"]);
          expect(state.deploys[0].bindings.map(resourceOf).sort()).toEqual([
            "ingest-db",
            "site-index",
          ]);

          // The user deletes that worker's last remote binding; it restarts
          // under the same name registering nothing at all.
          yield* startWorkerWithoutRemoteBindings("removal-ingest");

          // The surviving worker has not used its binding yet, so this is the
          // first call to its outbound Durable Object and it forces a fresh
          // deploy rather than reusing a cached preview session.
          const after = yield* fetchBody(site);
          expect(after.status, `site worker failed: ${after.body}`).toBe(200);
          expect(after.body).toBe("bound:site-index");

          // The deleted worker's binding is gone from the union...
          expect(state.deploys).toHaveLength(2);
          const deploy = state.deploys[1];
          expect(userFacingNames(deploy)).toEqual(["VECTORS"]);
          expect(deploy.bindings.map(resourceOf)).toEqual(["site-index"]);
          expect(deploy.bindings.map((binding) => binding.name)).not.toContain(
            state.deploys[0].bindings.find(
              (binding) => resourceOf(binding) === "ingest-db",
            )!.name,
          );

          // ...and the other worker's is untouched, still namespaced and still
          // resolving to its own resource on the live script.
          expectNamespacedAndDistinct(deploy);
          expect(state.live.size).toBe(1);
        }).pipe(Effect.scoped, Effect.provide(captureLogs)),
      { timeout: 30_000 },
    );
  },
);
