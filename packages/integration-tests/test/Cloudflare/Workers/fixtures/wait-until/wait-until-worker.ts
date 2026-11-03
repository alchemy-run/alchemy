import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

type RecordEntry<R> = (entry: string) => Effect.Effect<void, never, R>;

/**
 * A resource bound to the current event's scope. Its release is journaled
 * as `<label>:released`.
 */
const acquireResource = <R>(record: RecordEntry<R>, label: string) =>
  Effect.acquireRelease(
    Effect.sync(() => ({ released: false })),
    (resource) =>
      Effect.sync(() => {
        resource.released = true;
      }).pipe(Effect.andThen(record(`${label}:released`))),
  );

/**
 * Background work that uses the resource after the event has returned, and
 * journals whether it was still `open`.
 */
const useLater = <R>(record: RecordEntry<R>, resource: { released: boolean }, label: string) =>
  Effect.sleep("200 millis").pipe(
    Effect.andThen(
      Effect.suspend(() => record(`${label}:${resource.released ? "released" : "open"}`)),
    ),
  );

/** Slow background work: journals `<label>:done` after 3 seconds. */
const doneLater = <R>(record: RecordEntry<R>, label: string) =>
  Effect.sleep("3 seconds").pipe(Effect.andThen(record(`${label}:done`)));

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
      const append = (entry: string) =>
        state.storage
          .transaction(
            Effect.gen(function* () {
              const entries = (yield* state.storage.get<string[]>("entries")) ?? [];
              yield* state.storage.put("entries", [...entries, entry]);
            }),
          )
          .pipe(Effect.orDie);
      return {
        // `/hold/<label>`: `holdLater` over the Durable Object's HTTP path.
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          const label = new URL(request.url, "http://x").pathname.split("/")[2] ?? "";
          const resource = yield* acquireResource(append, label);
          yield* state.waitUntil(useLater(append, resource, label));
          return HttpServerResponse.text("scheduled");
        }),
        record: append,
        recordManyLater: Effect.fn(function* () {
          yield* state.waitUntil(
            Effect.sleep("100 millis").pipe(
              Effect.andThen(
                Effect.forEach(
                  Array.from({ length: 40 }, (_, i) => `parallel-${i}`),
                  append,
                  { concurrency: "unbounded" },
                ),
              ),
            ),
          );
          return "scheduled" as const;
        }),
        recordLater: Effect.fn(function* (entry: string) {
          yield* state.waitUntil(Effect.sleep("100 millis").pipe(Effect.andThen(append(entry))));
          return "scheduled" as const;
        }),
        // Scope finalizers added inside a DO method run after the method
        // returns: the bridge closes the per-call scope and registers the
        // close promise with `state.waitUntil`.
        recordOnClose: Effect.fn(function* (entry: string) {
          yield* Effect.addFinalizer(() =>
            Effect.sleep("100 millis").pipe(Effect.andThen(append(entry)), Effect.ignore),
          );
          return "scheduled" as const;
        }),
        // `waitUntil` work that uses a resource bound to this call's scope.
        holdLater: Effect.fn(function* (label: string) {
          const resource = yield* acquireResource(append, label);
          yield* state.waitUntil(useLater(append, resource, label));
          return "scheduled" as const;
        }),
        // Background work that hands more work to `state.waitUntil`.
        holdNested: Effect.fn(function* (label: string) {
          const resource = yield* acquireResource(append, label);
          yield* state.waitUntil(
            Effect.sleep("100 millis").pipe(
              Effect.andThen(state.waitUntil(useLater(append, resource, label))),
            ),
          );
          return "scheduled" as const;
        }),
        // Background work that fails doesn't stop the call's scope closing.
        holdFailing: Effect.fn(function* (label: string) {
          yield* state.waitUntil(Effect.fail("background failure"));
          const resource = yield* acquireResource(append, label);
          yield* state.waitUntil(useLater(append, resource, label));
          return "scheduled" as const;
        }),
        // The same, from a method whose Stream result takes over the call's
        // scope until the caller has drained it.
        streamLater: (label: string) =>
          Effect.gen(function* () {
            const resource = yield* acquireResource(append, label);
            yield* state.waitUntil(useLater(append, resource, label));
            return Stream.make("a", "b");
          }),
        // A Stream result whose `waitUntil` work outlasts it.
        streamSlow: (label: string) =>
          Effect.gen(function* () {
            yield* state.waitUntil(doneLater(append, label));
            return Stream.make("a", "b");
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

const BackgroundApi = HttpApi.make("BackgroundApi").add(
  HttpApiGroup.make("Background").add(
    HttpApiEndpoint.get("bg", "/api/bg", { success: Schema.String }),
    HttpApiEndpoint.get("lifetime", "/api/lifetime/:label", {
      params: Schema.Struct({ label: Schema.String }),
      success: Schema.String,
    }),
  ),
);

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
    // Probes: observe how often the init closure itself runs and if/when a
    // finalizer added in the init closure runs. Counted on globalThis and
    // exposed via /init-runs and /init-finalizer-runs.
    yield* Effect.sync(() => {
      (globalThis as any).__initRuns = ((globalThis as any).__initRuns ?? 0) + 1;
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        (globalThis as any).__initFinalizerRuns =
          ((globalThis as any).__initFinalizerRuns ?? 0) + 1;
      }),
    );

    // HttpApi routes built once, in init (#2173): `HttpApiBuilder.group`
    // captures the init context and re-provides it over each handler, so
    // `waitUntil` must still reach the live per-event context.
    const api = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(BackgroundApi).pipe(
        Layer.provide(
          HttpApiBuilder.group(BackgroundApi, "Background", (handlers) =>
            handlers
              .handle("lifetime", ({ params: { label } }) =>
                Effect.gen(function* () {
                  const record = (entry: string) =>
                    journals.getByName(label).record(entry).pipe(Effect.orDie);
                  const resource = yield* acquireResource(record, label);
                  yield* Cloudflare.waitUntil(useLater(record, resource, label));
                  return "scheduled";
                }),
              )
              .handle("bg", () =>
                Effect.gen(function* () {
                  yield* Cloudflare.waitUntil(
                    Effect.sleep("100 millis").pipe(
                      Effect.andThen(
                        journals.getByName("default").record("from-http-api-wait-until"),
                      ),
                    ),
                  );
                  return "bg-api-scheduled";
                }),
              ),
          ),
        ),
        Layer.provide(Http.Platform),
      ),
    );

    return {
      // RPC method for `/lifetime/rpc`: `waitUntil` work in a Worker RPC call.
      holdLater: (label: string) =>
        Effect.gen(function* () {
          const record = (entry: string) =>
            journals.getByName(label).record(entry).pipe(Effect.orDie);
          const resource = yield* acquireResource(record, label);
          yield* Cloudflare.waitUntil(useLater(record, resource, label));
          return "scheduled";
        }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const journal = journals.getByName("default");

        if (url.pathname.startsWith("/api/")) {
          return yield* api;
        }

        // `/lifetime/<case>/<label>`: `waitUntil` work that uses a resource
        // bound to the event's scope, journaled under `<label>`.
        if (url.pathname.startsWith("/lifetime/")) {
          const [, , kind, label = ""] = url.pathname.split("/");
          const journal = journals.getByName(label);
          const record = (entry: string) => journal.record(entry).pipe(Effect.orDie);
          if (kind === "entries") {
            return yield* HttpServerResponse.json(yield* journal.snapshot());
          }
          if (kind === "worker") {
            const resource = yield* acquireResource(record, label);
            yield* Cloudflare.waitUntil(useLater(record, resource, label));
          } else if (kind === "nested") {
            // Background work that hands more work to `waitUntil`.
            const resource = yield* acquireResource(record, label);
            yield* Cloudflare.waitUntil(
              Effect.sleep("100 millis").pipe(
                Effect.andThen(Cloudflare.waitUntil(useLater(record, resource, label))),
              ),
            );
          } else if (kind === "failing") {
            yield* Cloudflare.waitUntil(Effect.fail("background failure"));
            const resource = yield* acquireResource(record, label);
            yield* Cloudflare.waitUntil(useLater(record, resource, label));
          } else if (kind === "stream") {
            // A streamed body takes over the request scope from the bridge.
            const resource = yield* acquireResource(record, label);
            yield* Cloudflare.waitUntil(useLater(record, resource, label));
            return HttpServerResponse.stream(Stream.make("streamed").pipe(Stream.encodeText));
          } else if (kind === "slow-stream") {
            // A streamed body must not wait for the event's `waitUntil` work.
            yield* Cloudflare.waitUntil(doneLater(record, label));
            return HttpServerResponse.stream(Stream.make("streamed").pipe(Stream.encodeText));
          } else if (kind === "scoped") {
            // Work handed off inside a scoped region must not hold it open.
            yield* Effect.scoped(
              Cloudflare.waitUntil(
                Effect.sleep("3 seconds").pipe(Effect.andThen(record(`${label}:done`))),
              ),
            );
          } else if (kind === "rpc") {
            // This Worker's own RPC method, through a loopback stub.
            const self = yield* exec.exports.default().pipe(Effect.orDie);
            const rpc = self.raw as unknown as { holdLater: (label: string) => Promise<string> };
            return HttpServerResponse.text(yield* Effect.promise(() => rpc.holdLater(label)));
          } else if (kind === "do") {
            return HttpServerResponse.text(yield* journal.holdLater(label));
          } else if (kind === "do-nested") {
            return HttpServerResponse.text(yield* journal.holdNested(label));
          } else if (kind === "do-failing") {
            return HttpServerResponse.text(yield* journal.holdFailing(label));
          } else if (kind === "do-fetch") {
            const text = yield* Cloudflare.toHttpClient(journal)
              .execute(HttpClientRequest.get(`http://journal/hold/${label}`))
              .pipe(
                Effect.flatMap((response) => response.text),
                Effect.orDie,
              );
            return HttpServerResponse.text(text);
          } else if (kind === "do-slow-stream") {
            // Nor must a streamed RPC result.
            const values = yield* Stream.runCollect(yield* journal.streamSlow(label));
            return HttpServerResponse.text(values.join(","));
          } else if (kind === "do-stream") {
            const values = yield* Stream.runCollect(yield* journal.streamLater(label));
            return HttpServerResponse.text(values.join(","));
          } else {
            return HttpServerResponse.text("Not Found", { status: 404 });
          }
          return HttpServerResponse.text("scheduled");
        }

        if (url.pathname === "/bg-many") {
          const journal = journals.getByName("parallel");
          return HttpServerResponse.text(`bg-many-${yield* journal.recordManyLater()}`);
        }
        if (url.pathname === "/entries-many") {
          return yield* HttpServerResponse.json(yield* journals.getByName("parallel").snapshot());
        }
        if (url.pathname === "/bg") {
          yield* exec.waitUntil(
            Effect.sleep("100 millis").pipe(
              Effect.andThen(journal.record("from-worker-wait-until")),
            ),
          );
          return HttpServerResponse.text("bg-scheduled");
        }

        if (url.pathname === "/bg-do") {
          return HttpServerResponse.text(
            `bg-do-${yield* journal.recordLater("from-do-wait-until")}`,
          );
        }

        // Scope finalizers added in a fetch handler run after the response
        // is sent: the bridge closes the request scope and registers the
        // close promise with `ctx.waitUntil`.
        if (url.pathname === "/finalizer") {
          yield* Effect.addFinalizer(() =>
            Effect.sleep("100 millis").pipe(
              Effect.andThen(journal.record("from-request-finalizer")),
              Effect.ignore,
            ),
          );
          return HttpServerResponse.text("finalizer-scheduled");
        }

        if (url.pathname === "/finalizer-do") {
          return HttpServerResponse.text(
            `do-finalizer-${yield* journal.recordOnClose("from-do-finalizer")}`,
          );
        }

        if (url.pathname === "/entries") {
          return yield* HttpServerResponse.json(yield* journal.snapshot());
        }

        if (url.pathname === "/init-finalizer-runs") {
          return HttpServerResponse.text(String((globalThis as any).__initFinalizerRuns ?? 0));
        }

        if (url.pathname === "/init-runs") {
          return HttpServerResponse.text(String((globalThis as any).__initRuns ?? 0));
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
