// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is prebundled into the Worker next to the OpenNext artifact
// and re-evaluated inside workerd. The provider barrel would drag the
// entire IaC engine into that graph — the service-level subpaths keep it to
// the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import * as Queues from "alchemy/Cloudflare/Queues";
import { Nextjs } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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
 * OpenNext worker artifact so the queue handler is delivered alongside
 * `fetch`. (Local queue delivery is prod-only for Next — `alchemy dev`
 * serves the frontend, but consumed batches only flow in a real deploy.)
 */
export const Jobs = Queues.Queue("Jobs");

/**
 * ONE Worker serves the Next.js app AND a typed backend: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose RPC METHODS are the API surface for TRUSTED callers only. There
 * is no public wire — `createClient(Backend)` (the value form) dispatches
 * them in-process from server code: async server components and the
 * server actions in app/actions.ts, which are Next's own transport for
 * the browser. The takeover is automatic — alchemy wraps the OpenNext
 * worker artifact with a generated entry that delivers the program's
 * platform handlers (the queue consumer below) alongside `fetch`; every
 * HTTP path (including Next's own /api/hello route handler) stays Next's.
 *
 * The KV capability the program uses is collected automatically at plan
 * time — no separate backend worker, service binding, proxy route, or env
 * shim.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated entry re-imports it at
 * runtime.
 */
export default class Site extends Nextjs<Site>()(
  "Nextjs",
  {
    main: import.meta.url,
    // Only hash the files that affect the build, so unchanged sources
    // skip the OpenNext build (and the deploy) entirely.
    memo: {
      include: [
        "app/**",
        "public/**",
        "package.json",
        "next.config.mjs",
        "postcss.config.mjs",
        "open-next.config.ts",
        "app/backend.ts",
        "tsconfig.json",
      ],
    },
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
        Stream.runForEach(
          stream,
          Effect.fn(function* (msg) {
            const count = Number((yield* visits.get("processed-count")) ?? "0");
            yield* visits.put("processed-count", String(count + 1));
            yield* visits.put("processed-last", String(msg.body));
          }, Effect.orDie),
        ),
    );

    return {
      // RPC methods — the KV-backed visit counter. Invoked directly (no
      // HTTP) by the value form of `createClient` from trusted server
      // code: the async server component and the server actions.
      visits: Effect.fn(function* () {
        return Number((yield* visits.get("count")) ?? "0");
      }, Effect.orDie),
      bump: Effect.fn(function* () {
        const count = Number((yield* visits.get("count")) ?? "0") + 1;
        yield* visits.put("count", String(count));
        return count;
      }, Effect.orDie),
      // The async leg's producer (called by the `enqueueJob` server
      // action) — sends a message to the queue; the consumer above
      // catches up asynchronously.
      enqueue: (message: string) =>
        jobs
          .send(message, { contentType: "text" })
          .pipe(Effect.asVoid, Effect.orDie),
      // Read the consumer's async state (the `getProcessed` server action).
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
