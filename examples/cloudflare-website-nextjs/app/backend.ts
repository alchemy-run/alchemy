// Narrow subpath imports, deliberately NOT the `alchemy/Cloudflare` barrel:
// this module is prebundled into the Worker next to the OpenNext artifact
// and re-evaluated inside workerd. The provider barrel would drag the
// entire IaC engine into that graph — the service-level subpaths keep it to
// the construct + capability slice.
import * as KV from "alchemy/Cloudflare/KV";
import * as Queues from "alchemy/Cloudflare/Queues";
import { Nextjs } from "alchemy/Cloudflare/Website";
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
 * ONE Worker serves the Next.js app AND a typed backend — the maximal
 * shape (Serve/DESIGN.md "MaxSite"): an Effect `fetch` API (streaming
 * route, request-scope finalizer route), a Durable Object, a durable
 * Workflow, a queue produced to AND consumed on the same class, and RPC
 * METHODS for trusted callers — `createClient(Backend)` (the value form)
 * dispatches them in-process from server code: async server components and
 * the server actions in app/actions.ts, which are Next's own transport for
 * the browser.
 *
 * HTTP composition lives in app/api/[[...slug]]/route.ts — the mount.
 * Everything platform-shaped (queue consumer, DO/Workflow class exports,
 * bindings) derives from the `yield*` registrations below; the generated
 * wrapper around the OpenNext artifact delivers it alongside Next's own
 * handler.
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
        "tsconfig.json",
      ],
    },
  },
  Effect.gen(function* () {
    // Init: runs at plan time in the engine (collects the bindings) and
    // again inside the Worker on first request (builds the runtime client).
    const visits = yield* KV.ReadWriteNamespace(yield* Visits);
    const jobsQueue = yield* Jobs;
    const jobs = yield* Queues.WriteQueue(jobsQueue);
    // Platform registrations — each yield* IS the wiring: binding +
    // migration/config + class export in the generated worker entry.
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
      // ── Effect HTTP API (paths the route-file mount routes here) ──
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://site");

        if (url.pathname === "/api/do/increment") {
          const name = url.searchParams.get("name") ?? "default";
          const next = yield* counters
            .getByName(name)
            .increment(1)
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ next });
        }

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

        if (url.pathname === "/api/finalizer") {
          const value = url.searchParams.get("v") ?? "ran";
          yield* Effect.addFinalizer(() =>
            visits.put("finalizer-last", value).pipe(Effect.ignore),
          );
          return yield* HttpServerResponse.json({ registered: value });
        }

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

        if (url.pathname === "/api/enqueue") {
          const message = url.searchParams.get("m") ?? "job";
          yield* jobs.send(message, { contentType: "text" }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ sent: message });
        }

        if (url.pathname === "/api/kv") {
          const key = url.searchParams.get("key") ?? "";
          const value = yield* visits.get(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
        }

        return HttpServerResponse.empty({ status: 404 });
      }),

      // ── Value-form methods (createClient from Next server code) ──
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
