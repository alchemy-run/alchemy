import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Durable Object journal for `FinalizerLatency.test.ts` — durable storage so
 * the "finalizer actually ran" readback is isolate-independent (a module
 * global would only be visible to the isolate that served the request).
 */
export class LatencyJournal extends Cloudflare.DurableObject<LatencyJournal>()(
  "LatencyJournal",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      return {
        record: Effect.fn(function* (entry: string) {
          const entries = (yield* state.storage.get<string[]>("entries")) ?? [];
          yield* state.storage.put("entries", [...entries, entry]);
        }),
        snapshot: Effect.fn(function* () {
          return {
            entries: (yield* state.storage.get<string[]>("entries")) ?? [],
          };
        }),
      };
    });
  }),
) {}

/**
 * Fixture worker for `FinalizerLatency.test.ts`.
 *
 * `GET /finalize` registers a SLOW (3s) `Effect.addFinalizer` and responds
 * immediately. The documented bridge contract is that request-scope
 * finalizers settle post-response via `ctx.waitUntil` — so the response
 * latency must NOT include the 3s. The finalizer records a journal entry
 * when it completes, which the test reads back via `GET /entries`.
 */
export default class FinalizerLatencyWorker extends Cloudflare.Worker<FinalizerLatencyWorker>()(
  "FinalizerLatencyWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const journals = yield* LatencyJournal;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const journal = journals.getByName("default");

        if (url.pathname === "/finalize") {
          yield* Effect.addFinalizer(() =>
            Effect.sleep("3 seconds").pipe(
              Effect.andThen(journal.record("slow-finalizer-ran")),
              Effect.ignore,
            ),
          );
          return HttpServerResponse.text("finalizer-scheduled");
        }

        if (url.pathname === "/entries") {
          return yield* HttpServerResponse.json(yield* journal.snapshot());
        }

        return HttpServerResponse.text("ready-ok");
      }),
    };
  }),
) {}
