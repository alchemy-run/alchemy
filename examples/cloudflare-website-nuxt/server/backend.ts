// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is re-imported by the generated nitro entry wrapper on deploy
// and by the dev middleware inside nitro's dev worker thread. The provider
// barrel would drag the entire IaC engine into that graph — the
// service-level subpaths keep it to the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import * as Queues from "alchemy/Cloudflare/Queues";
import { Nuxt } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * KV namespace bound by the site's Effect program. Registered on the stack
 * when the program's init Effect runs at plan time — no separate wiring in
 * alchemy.run.ts needed.
 */
export const Visits = KV.Namespace("Visits");

/**
 * Queue bound by the site's Effect program — the async leg. The program
 * both produces to it (the `enqueue` RPC method) and CONSUMES it on the
 * SAME class via `consumeQueueMessages`; the entry takeover wraps the
 * nitro artifact so the queue handler is delivered alongside `fetch`.
 * (Local queue delivery is prod-only for Nuxt — `alchemy dev` serves the
 * frontend, but consumed batches only flow in a real deploy.)
 */
export const Jobs = Queues.Queue("Jobs");

/**
 * ONE Worker serves the Nuxt app AND a typed backend API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose RPC METHODS are the API surface. `createClient` calls them — over
 * `POST /api/__rpc/<method>` from the browser (type-only form) and by
 * direct in-process dispatch during SSR (value form). Capability bindings
 * the program uses (the KV namespace here) are collected automatically at
 * plan time.
 *
 * The program also keeps a `fetch` to demonstrate `server.routes`
 * ownership: inside the claim the program is authoritative (even its
 * 404s), while the exclusion glob `!/api/hello` statically hands that path
 * back to nitro, so the app's own `/api/hello` route keeps working. (The
 * RPC dispatch at `/api/__rpc/*` needs no claim — it is checked before
 * `server.routes` on every effectful Website.)
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated entry re-imports it at
 * runtime.
 */
export default class Site extends Nuxt<Site>()(
  "NuxtSite",
  {
    main: import.meta.url,
    // The URL space the Effect fetch owns. `!/api/hello` excludes nitro's
    // own route from the claim — exclusions win, so nitro serves it;
    // every other /api/* path is answered by the program (even 404s).
    server: { routes: ["/api/*", "!/api/hello"] },
  },
  Effect.gen(function* () {
    // Init: runs at plan time in the engine (collects the KV binding) and
    // again inside the Worker on first request (builds the runtime client).
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    const jobsQueue = yield* Jobs;
    const jobs = yield* Queues.WriteQueue(jobsQueue);

    // The async leg's consumer — a queue listener on the SAME class. At
    // plan time this yields the `Cloudflare.Queues.Consumer` resource; at
    // runtime queue batches dispatch to it. Each message bumps
    // `processed-count` and records `processed-last` in KV, where the
    // `processed` RPC method reads them back.
    yield* Queues.consumeQueueMessages<string>(
      jobsQueue,
      {
        batchSize: 5,
        maxRetries: 2,
        maxWaitTime: "1 second",
        retryDelay: "2 seconds",
      },
      (stream) =>
        Stream.runForEach(stream, Effect.fn(function* (msg) {
            const count = Number(
              (yield* visits.get("processed-count")) ?? "0",
            );
            yield* visits.put("processed-count", String(count + 1));
            yield* visits.put("processed-last", String(msg.body));
          }, Effect.orDie),
        ),
    );

    return {
      // The program owns everything inside `server.routes` (with
      // /api/hello excluded above), so /api/* paths get its own 404 —
      // never nitro. The real API surface is the RPC methods below.
      fetch: HttpServerResponse.json(
        { error: "unknown effect route" },
        { status: 404 },
      ),
      // RPC methods — the KV-backed visit counter. Served to `createClient`
      // at the universal `POST /api/__rpc/<method>` dispatch, and invoked
      // directly (no HTTP) by the value form during SSR.
      visits: Effect.fn(function* () {
          return Number((yield* visits.get("count")) ?? "0");
        }, Effect.orDie),
      bump: Effect.fn(function* () {
          const count = Number((yield* visits.get("count")) ?? "0") + 1;
          yield* visits.put("count", String(count));
          return count;
        }, Effect.orDie),
      // The async leg's producer (RPC: POST /api/__rpc/enqueue) — sends a
      // message to the queue; the consumer above catches up asynchronously.
      enqueue: (message: string) =>
        jobs
          .send(message, { contentType: "text" })
          .pipe(Effect.asVoid, Effect.orDie),
      // Read the consumer's async state (RPC: POST /api/__rpc/processed).
      processed: Effect.fn(function* () {
          const count = yield* visits.get("processed-count");
          const last = yield* visits.get("processed-last");
          return { count: Number(count ?? "0"), last: last ?? null };
        }, Effect.orDie),
    };
  }).pipe(
    Effect.provide(KV.ReadWriteNamespaceBinding),
    Effect.provide(Queues.WriteQueueBinding),
    Effect.provide(Queues.EventSourceLive),
  ),
) {}
