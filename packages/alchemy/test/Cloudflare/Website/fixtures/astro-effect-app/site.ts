// Narrow subpath imports (DESIGN §6.1 bundle hygiene): this module is
// re-imported inside workerd — in dev through the vite module runner, which
// evaluates every module in the graph without tree-shaking. The provider
// barrel (`alchemy/Cloudflare`) drags the whole IaC engine (bundlers, local
// runtimes, workerd host machinery) into that graph; the service-level
// subpaths keep it to the construct + capability slice.
import {
  Namespace,
  ReadWriteNamespace,
  ReadWriteNamespaceBinding,
} from "alchemy/Cloudflare/KV";
import {
  consumeQueueMessages,
  EventSourceLive,
  Queue,
  WriteQueue,
  WriteQueueBinding,
} from "alchemy/Cloudflare/Queues";
import { Astro } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RouteNotFound } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * KV namespace bound by the effectful Website's program. Registered on the
 * stack when the site's init Effect runs at plan time; tests import it (from
 * their clone of this fixture) to assert its identity out of band
 * (`dev:`-prefixed locally, a real namespace id live).
 */
export const Users = Namespace("AstroEffectUsers");

/**
 * Queue bound by the effectful Website's program — the async leg. The
 * impl both produces to it (the `enqueue` RPC method) and CONSUMES it on
 * the same class via `consumeQueueMessages`, whose listener is delivered
 * by the entry-takeover wrapper (the vendored astro worker entry is
 * wrapped with the Worker bridge's non-fetch handler surface — fetch
 * stays with the fetchable).
 */
export const Jobs = Queue("AstroEffectJobs");

/**
 * The Astro fetchable-wrapper delivery shape (DESIGN §6.2c): one Worker
 * serves the Astro frontend AND the Effect program's API. The integration
 * pre-resolves `virtual:astro:fetchable` to a generated wrapper importing
 * this module by absolute path — the effect fetch is authoritative inside
 * `server.routes`, Astro's own pipeline serves everything outside them.
 * Exercises:
 *
 * - the KV capability binding collected at plan and served at runtime;
 * - strict route ownership (`/api/astro-echo` is a real Astro endpoint
 *   carved out of the claim by the `!/api/astro-echo` exclusion glob —
 *   Astro serves it; unknown in-claim paths get the effect's OWN 404);
 * - SSR pages and static assets outside `server.routes`;
 * - the prerender guard (`about.astro` prerenders in the workerd prerender
 *   worker, which never loads the effect wrapper).
 *
 * `main: import.meta.url` anchors this module: the engine imports it for
 * plan-time binding collection and the generated fetchable wrapper
 * re-imports it inside the Astro `ssr` graph. Tests clone the fixture and
 * dynamically import the clone's copy, so concurrent suites never share
 * a build directory.
 */
export default class AstroEffectSite extends Astro<AstroEffectSite>()(
  "AstroEffectSite",
  {
    main: import.meta.url,
    rootDir: import.meta.dirname,
    workersDev: { enabled: true, previewsEnabled: true },
    compatibility: { date: "2026-03-10" },
    // Strict route ownership: the effect fetch owns `/api/*` EXCEPT
    // `/api/astro-echo`, which the exclusion glob routes to Astro's own
    // endpoint.
    server: { routes: ["/api/*", "!/api/astro-echo"] },
    dev: { port: 0 },
    memo: {
      include: [
        "astro.config.mjs",
        "package.json",
        "public/**",
        "site.ts",
        "src/**",
      ],
      workspaces: [],
    },
  },
  Effect.gen(function* () {
    const namespace = yield* Users;
    const users = yield* ReadWriteNamespace(namespace);
    const jobsQueue = yield* Jobs;
    const jobs = yield* WriteQueue(jobsQueue);

    // The async leg's consumer — a queue listener on the SAME class. At
    // plan time this yields the `Cloudflare.Queues.Consumer` resource; at
    // runtime the entry-takeover wrapper dispatches queue batches to it.
    // Each message bumps `processed-count` and records `processed-last`
    // in KV, where the `processed` RPC method reads them back.
    yield* consumeQueueMessages<string>(
      jobsQueue,
      {
        batchSize: 5,
        maxRetries: 2,
        maxWaitTime: "1 second",
        retryDelay: "2 seconds",
      },
      (stream) =>
        Stream.runForEach(stream, (msg) =>
          Effect.gen(function* () {
            const count = Number(
              (yield* users.get("processed-count").pipe(Effect.orDie)) ?? "0",
            );
            yield* users
              .put("processed-count", String(count + 1))
              .pipe(Effect.orDie);
            yield* users
              .put("processed-last", String(msg.body))
              .pipe(Effect.orDie);
          }),
        ),
    );

    return {
      /** Send a message to the queue (RPC: POST /api/__rpc/enqueue). */
      enqueue: (message: string) =>
        jobs.send(message, { contentType: "text" }).pipe(Effect.orDie),
      /** Read the consumer's async state (RPC: POST /api/__rpc/processed). */
      processed: () =>
        Effect.gen(function* () {
          const count = yield* users.get("processed-count").pipe(Effect.orDie);
          const last = yield* users.get("processed-last").pipe(Effect.orDie);
          return { count: Number(count ?? "0"), last: last ?? null };
        }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // `request.url` is path-shaped inside the effect fetch; the base
        // makes the parse total either way.
        const url = new URL(request.url, "http://fixture");
        if (url.pathname === "/api/kv") {
          const key = url.searchParams.get("key") ?? "default";
          if (request.method === "PUT") {
            const value = url.searchParams.get("value") ?? "";
            yield* users.put(key, value).pipe(Effect.orDie);
            return yield* HttpServerResponse.json({ ok: true, key, value });
          }
          const value = yield* users.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
        }
        if (url.pathname === "/api/marker") {
          return yield* HttpServerResponse.json({
            marker: "astro-effect-fetch",
            path: url.pathname,
          });
        }
        // The HttpRouter-miss shape: renders as the effect's OWN empty
        // 404 — inside the claim the effect fetch is authoritative
        // (delegation to Astro happens only via the exclusion glob).
        return yield* Effect.fail(new RouteNotFound({ request }));
      }),
    };
  }).pipe(
    Effect.provide(ReadWriteNamespaceBinding),
    Effect.provide(WriteQueueBinding),
    Effect.provide(EventSourceLive),
  ),
) {}
