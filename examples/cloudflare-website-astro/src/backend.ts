// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is re-imported inside the Worker by the generated entry, and
// in dev the vite module runner evaluates its whole import graph. The
// provider barrel would drag the entire IaC engine into that graph — the
// service-level subpaths keep it to the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import * as Queues from "alchemy/Cloudflare/Queues";
import { Astro } from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
 * SAME class via `consumeQueueMessages`; the generated Worker entry
 * delivers the queue handler alongside `fetch`.
 */
export const Jobs = Queues.Queue("Jobs");

/**
 * ONE Worker serves the Astro frontend AND a typed backend API: the third
 * argument is an Effect program (the same shape as `Cloudflare.Worker`)
 * whose RPC METHODS are the API surface for TRUSTED callers.
 * `createClient(Backend)` (the value form) dispatches them in-process
 * from server code — Astro frontmatter and Astro Action handlers; the
 * browser only ever talks to the framework's own transport
 * (`/_actions/*`). Capability bindings the program uses (the KV namespace
 * here) are collected automatically at plan time.
 *
 * `main: import.meta.url` anchors this module — the engine imports it for
 * plan-time binding collection and the generated Worker entry re-imports it
 * at runtime.
 */
export default class Site extends Astro<Site>()(
  "Astro",
  {
    main: import.meta.url,
    // Only hash the files that affect the build, so unchanged sources
    // skip the Astro build (and the deploy) entirely.
    memo: {
      include: [
        "src/**",
        "public/**",
        "package.json",
        "astro.config.ts",
        "src/backend.ts",
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
      // RPC methods — the KV-backed visit counter. Invoked in-process by
      // `createClient(Backend)` from Astro frontmatter (SSR) and from the
      // Astro Action handlers in src/actions/index.ts.
      visits: Effect.fn(function* () {
        return Number((yield* visits.get("count")) ?? "0");
      }, Effect.orDie),
      bump: Effect.fn(function* () {
        const count = Number((yield* visits.get("count")) ?? "0") + 1;
        yield* visits.put("count", String(count));
        return count;
      }, Effect.orDie),
      // The async leg's producer (called by the `enqueue` action) — sends
      // a message to the queue; the consumer above catches up
      // asynchronously.
      enqueue: (message: string) =>
        jobs
          .send(message, { contentType: "text" })
          .pipe(Effect.asVoid, Effect.orDie),
      // Read the consumer's async state (called by the `processed` action).
      processed: Effect.fn(function* () {
        const count = yield* visits.get("processed-count");
        const last = yield* visits.get("processed-last");
        return { count: Number(count ?? "0"), last: last ?? null };
      }, Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        KV.ReadWriteNamespaceBinding,
        Queues.WriteQueueBinding,
        Queues.EventSourceLive,
      ),
    ),
  ),
) {}
