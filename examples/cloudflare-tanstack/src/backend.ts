// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module joins the TanStack Start vite graph (the generated worker
// entry imports it), and in dev the vite module runner evaluates every
// module in that graph. The provider barrel would drag the entire IaC
// engine into it — the service-level subpaths keep it to the construct +
// capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import * as Queues from "alchemy/Cloudflare/Queues";
import * as Website from "alchemy/Cloudflare/Website";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Counter } from "./counter.ts";
import ReportWorkflow from "./report-workflow.ts";
import { Jobs, Visits } from "./resources.ts";

export { Jobs, Visits };

/**
 * ONE Worker serves the TanStack Start app AND a typed backend — the
 * maximal shape (Serve/DESIGN.md "MaxSite"): an Effect `fetch` API
 * (including a streaming route and a request-scope finalizer route), a
 * Durable Object, a durable Workflow, a queue produced to AND consumed on
 * the same class, and RPC methods for the value-form `createClient` used
 * by the TanStack server functions in src/server/visits.ts.
 *
 * HTTP composition lives in src/server.ts (`server.entry`) — the mount
 * file this class points at. Everything platform-shaped (queue consumer,
 * DO/Workflow class exports, bindings) derives from the `yield*`
 * registrations below; nothing is configured elsewhere.
 */
export default class Site extends Website.Vite<Site>()(
  "Website",
  {
    main: import.meta.url,
    server: {
      // The user-owned worker entry (the mount): grafted verbatim as the
      // deployed fetch — its own routing decides, no `routes` gate.
      entry: "./server.ts",
    },
    compatibility: {
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    // Init: runs at plan time in the engine (collects bindings + platform
    // registrations) and again inside the Worker on first request.
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    const jobsQueue = yield* Jobs;
    const jobs = yield* Queues.WriteQueue(jobsQueue);
    // Platform registrations — each yield* IS the wiring: binding +
    // migration/config + class export in the generated entry.
    const counters = yield* Counter;
    const reports = yield* ReportWorkflow;

    // The async leg's consumer — a queue listener on the SAME class.
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
      // ── Effect HTTP API (served for paths src/server.ts routes here) ──
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://site");

        // DO round-trip: same name → same instance → monotonic counter.
        if (url.pathname === "/api/do/increment") {
          const name = url.searchParams.get("name") ?? "default";
          const next = yield* counters
            .getByName(name)
            .increment(1)
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ next });
        }

        // DO streaming RPC forwarded onto a streaming HTTP response —
        // exercises RPC stream plumbing AND response streaming (the
        // request scope ejects to the stream's lifetime).
        if (url.pathname === "/api/do/ticks") {
          const n = Number(url.searchParams.get("n") ?? "3");
          const stream = counters
            .getByName("ticker")
            .ticks(n)
            .pipe(
              Stream.map((i) => `${i}\n`),
              Stream.encodeText,
            );
          return HttpServerResponse.stream(stream, {
            headers: { "content-type": "text/plain" },
          });
        }

        // Request-scope finalizer: runs AFTER the response on workerd
        // (registered with ctx.waitUntil by the bridge). The test polls
        // /api/kv?key=finalizer-last to observe it.
        if (url.pathname === "/api/finalizer") {
          const value = url.searchParams.get("v") ?? "ran";
          yield* Effect.addFinalizer(() =>
            visits.put("finalizer-last", value).pipe(Effect.ignore),
          );
          return yield* HttpServerResponse.json({ registered: value });
        }

        // Workflow: start an instance / read its status.
        if (url.pathname === "/api/workflow/start") {
          const marker = url.searchParams.get("marker") ?? "default";
          const instance = yield* reports
            .create({ params: { marker } })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ id: instance.id });
        }
        if (url.pathname === "/api/workflow/status") {
          const id = url.searchParams.get("id") ?? "";
          const instance = yield* reports.get(id).pipe(Effect.orDie);
          const status = yield* instance.status().pipe(Effect.orDie);
          return yield* HttpServerResponse.json(status);
        }

        // Queue producer over HTTP (the dev leg can't compute Start's
        // production server-fn hashes; the RPC path stays covered live).
        if (url.pathname === "/api/enqueue") {
          const message = url.searchParams.get("m") ?? "job";
          yield* jobs.send(message, { contentType: "text" }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ sent: message });
        }

        // KV observability for the async legs (consumer, finalizer, WF).
        if (url.pathname === "/api/kv") {
          const key = url.searchParams.get("key") ?? "";
          const value = yield* visits.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
        }

        return HttpServerResponse.empty({ status: 404 });
      }),

      // ── RPC methods (value-form createClient, TanStack server fns) ──
      visits: Effect.fn(function* () {
        return Number((yield* visits.get("count")) ?? "0");
      }, Effect.orDie),
      bump: Effect.fn(function* () {
        const count = Number((yield* visits.get("count")) ?? "0") + 1;
        yield* visits.put("count", String(count));
        return count;
      }, Effect.orDie),
      enqueue: (message: string) =>
        jobs
          .send(message, { contentType: "text" })
          .pipe(Effect.asVoid, Effect.orDie),
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
