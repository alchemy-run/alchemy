import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Durable Object journal for `WaitUntil.test.ts`.
 *
 * `record` persists an entry inline. `recordLater` returns before persisting
 * and uses `DurableObjectState.waitUntil` to write the entry in the
 * background — the test only sees the entry if waitUntil actually kept the
 * DO alive past the RPC response.
 */
export class Journal extends Cloudflare.DurableObject<Journal>()(
  "Journal",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const append = Effect.fn(function* (entry: string) {
        const entries = (yield* state.storage.get<string[]>("entries")) ?? [];
        yield* state.storage.put("entries", [...entries, entry]);
      });
      return {
        record: append,
        recordLater: Effect.fn(function* (entry: string) {
          yield* state.waitUntil(
            Effect.sleep("100 millis").pipe(Effect.andThen(append(entry))),
          );
          return "scheduled" as const;
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
 * Fixture worker for `WaitUntil.test.ts`.
 *
 * `GET /bg` responds immediately and records a journal entry from a
 * background Effect via `WorkerExecutionContext.waitUntil`. `GET /bg-do`
 * exercises `DurableObjectState.waitUntil` inside the DO. The test polls
 * `GET /entries` until both entries appear.
 */
export default class WaitUntilWorker extends Cloudflare.Worker<WaitUntilWorker>()(
  "WaitUntilWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const journals = yield* Journal;
    // Yielded from the init closure (deferred instance) — its methods
    // resolve the live per-event context when invoked inside a handler.
    const exec = yield* Cloudflare.WorkerExecutionContext;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const journal = journals.getByName("default");

        if (url.pathname === "/bg") {
          yield* exec.waitUntil(
            Effect.sleep("100 millis").pipe(
              Effect.andThen(journal.record("from-worker-wait-until")),
            ),
          );
          return HttpServerResponse.text("scheduled");
        }

        if (url.pathname === "/bg-do") {
          return HttpServerResponse.text(
            yield* journal.recordLater("from-do-wait-until"),
          );
        }

        if (url.pathname === "/entries") {
          return yield* HttpServerResponse.json(yield* journal.snapshot());
        }

        if (url.pathname === "/raw") {
          const exec = yield* Cloudflare.WorkerExecutionContext;
          return HttpServerResponse.text(
            typeof exec.raw.waitUntil === "function" ? "ok" : "missing",
          );
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}
