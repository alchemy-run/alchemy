import * as Cloudflare from "@alchemy.run/cloudflare";
import { isWorkerEvent } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import type * as cf from "@cloudflare/workers-types";
import * as Http from "alchemy/Http";
import * as Rpc from "alchemy/Rpc";
import type { FunctionContext } from "alchemy/Runtime/Function";
import { CurrentRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
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

/** How a `resourceLines` body ends: drained, failing partway, or never. */
export type StreamMode = "complete" | "fail" | "cancel";

const streamModes: ReadonlyArray<string> = ["complete", "fail", "cancel"];
const isStreamMode = (mode: string | undefined): mode is StreamMode =>
  mode !== undefined && streamModes.includes(mode);

export class StreamFailure extends Data.TaggedError("StreamFailure")<{}> {}

/**
 * A streamed body that reports, one line every 200ms, whether `resource` is
 * still open: three lines, two lines and a failure, or lines until the
 * client cancels.
 */
const resourceLines = (resource: { released: boolean }, mode: StreamMode) =>
  (mode === "cancel" ? Stream.iterate(1, (n) => n + 1) : Stream.range(1, 3)).pipe(
    Stream.mapEffect((n) =>
      mode === "fail" && n === 3
        ? Effect.fail(new StreamFailure())
        : Effect.sleep("200 millis").pipe(
            Effect.andThen(Effect.sync(() => `${resource.released ? "released" : "open"}\n`)),
          ),
    ),
  );

/**
 * Background work that acquires a resource of its own, then uses it the way
 * {@link useLater} does.
 */
const acquireAndUseLater = <R>(record: RecordEntry<R>, label: string) =>
  Effect.gen(function* () {
    const resource = yield* acquireResource(record, label);
    yield* useLater(record, resource, label);
  });

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
          const path = new URL(request.url, "http://x").pathname.split("/");
          // `/socket/<label>`: a hibernatable WebSocket for `webSocketMessage`.
          if (path[1] === "socket") {
            const [response] = yield* Cloudflare.upgrade();
            return response;
          }
          // `/stream/<mode>/<label>`: a streamed body over a call-scoped resource.
          if (path[1] === "stream" && isStreamMode(path[2])) {
            const label = path[3] ?? "";
            const resource = yield* acquireResource(append, label);
            return HttpServerResponse.stream(
              resourceLines(resource, path[2]).pipe(Stream.encodeText),
            );
          }
          const label = path[2] ?? "";
          const resource = yield* acquireResource(append, label);
          yield* state.waitUntil(useLater(append, resource, label));
          return HttpServerResponse.text("scheduled");
        }),
        // Each message is a label: `waitUntil` work in a WebSocket event.
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const label = typeof message === "string" ? message : "";
          const resource = yield* acquireResource(append, label);
          yield* state.waitUntil(useLater(append, resource, label));
          yield* socket.send("scheduled");
        }),
        // `waitUntil` work in an alarm event, for the label `holdAlarm` stored.
        alarm: () =>
          Effect.gen(function* () {
            const label =
              (yield* state.storage.get<string>("alarm-label").pipe(Effect.orDie)) ?? "";
            const resource = yield* acquireResource(append, label);
            yield* state.waitUntil(useLater(append, resource, label));
          }),
        holdAlarm: Effect.fn(function* (label: string) {
          yield* state.storage.put("alarm-label", label).pipe(Effect.orDie);
          yield* state.storage.setAlarm(Date.now()).pipe(Effect.orDie);
          return "scheduled" as const;
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
        // Work handed off inside a scoped region that acquires its own
        // resource: the resource lives as long as the work, not the region.
        holdScopedAcquire: Effect.fn(function* (label: string) {
          yield* Effect.scoped(state.waitUntil(acquireAndUseLater(append, label)));
          return "scheduled" as const;
        }),
        // A method that fails after handing off work.
        holdFailingCall: Effect.fn(function* (label: string) {
          const resource = yield* acquireResource(append, label);
          yield* state.waitUntil(useLater(append, resource, label));
          return yield* new StreamFailure();
        }),
        // A Stream result that hands off work while the caller reads it.
        streamWaitUntil: (label: string) =>
          Effect.gen(function* () {
            const resource = yield* acquireResource(append, label);
            return Stream.fromEffect(
              state.waitUntil(useLater(append, resource, label)).pipe(Effect.as("a")),
            );
          }),
        // The same, from a method whose Stream result takes over the call's
        // scope until the caller has drained it.
        streamLater: (label: string) =>
          Effect.gen(function* () {
            const resource = yield* acquireResource(append, label);
            yield* state.waitUntil(useLater(append, resource, label));
            return Stream.make("a", "b");
          }),
        // A Stream result over a call-scoped resource.
        streamResource: (label: string, mode: StreamMode) =>
          Effect.gen(function* () {
            const resource = yield* acquireResource(append, label);
            return resourceLines(resource, mode);
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

/** Each message is a label for `waitUntil` work in a queue batch. */
export const LifetimeQueue = Cloudflare.Queues.Queue("WaitUntilLifetimeQueue");

/** The precreate placeholder can fail early batches; space their retries. */
const consumerSettings = {
  batchSize: 10,
  maxWaitTime: "1 second",
  maxRetries: 10,
  retryDelay: "3 seconds",
} as const;

/** Decode a Worker RPC result from a raw loopback stub, as a typed stub does. */
const decodeRpc = <A>(call: () => Promise<unknown>) =>
  Effect.promise(call).pipe(
    Effect.flatMap((value) => Rpc.decodeRpcResult(value)),
    Effect.map((value) => value as A),
    Effect.orDie,
  );

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

    // `waitUntil` work in a non-fetch event, journaled under `label`.
    const holdFor = Effect.fnUntraced(function* (label: string) {
      const record = (entry: string) => journals.getByName(label).record(entry).pipe(Effect.orDie);
      const resource = yield* acquireResource(record, label);
      yield* Cloudflare.waitUntil(useLater(record, resource, label));
    });

    // Each tick journals under `cron-<minute>`, its minute in epoch millis.
    yield* Cloudflare.Workers.cron("* * * * *", (controller) =>
      holdFor(`cron-${Math.floor(controller.scheduledTime / 60_000) * 60_000}`),
    );

    // Each message's subject is a label. No zone, so no routing is created:
    // the test delivers mail through the local runtime.
    yield* Cloudflare.email().subscribe((message) => holdFor(message.headers.get("subject") ?? ""));

    // `WaitUntilTailProducer` logs `lifetime:<label>` for each label.
    const runtime = (yield* CurrentRuntimeContext) as FunctionContext | undefined;
    if (runtime !== undefined) {
      yield* runtime.listen((event) => {
        if (!isWorkerEvent(event) || event.type !== "tail") return;
        const labels = (event.input as cf.TraceItem[])
          .flatMap((item) => item.logs.flatMap((log) => log.message as unknown[]))
          .filter((message): message is string => typeof message === "string")
          .filter((message) => message.startsWith("lifetime:"))
          .map((message) => message.slice("lifetime:".length));
        return Effect.forEach(labels, holdFor, { discard: true }).pipe(
          Effect.provideService(RuntimeContext, runtime),
        );
      });
    }

    const lifetimeQueue = yield* LifetimeQueue;
    const queue = yield* Cloudflare.Queues.QueueSink(lifetimeQueue);
    yield* Cloudflare.Queues.consumeQueueMessages<{ label: string }>(
      lifetimeQueue,
      consumerSettings,
      (messages) =>
        messages.pipe(
          Stream.map((message) => message.body.label),
          Stream.runCollect,
          Effect.flatMap((labels) =>
            Effect.forEach(
              labels,
              Effect.fnUntraced(function* (label) {
                const record = (entry: string) =>
                  journals.getByName(label).record(entry).pipe(Effect.orDie);
                const resource = yield* acquireResource(record, label);
                yield* Cloudflare.waitUntil(useLater(record, resource, label));
              }),
              { discard: true },
            ),
          ),
        ),
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
      // A Stream result, for `/lifetime/rpc-stream`.
      streamLater: (label: string) =>
        Effect.gen(function* () {
          const record = (entry: string) =>
            journals.getByName(label).record(entry).pipe(Effect.orDie);
          const resource = yield* acquireResource(record, label);
          yield* Cloudflare.waitUntil(useLater(record, resource, label));
          return Stream.make("a", "b");
        }),
      // A Stream result that hands off work while the caller reads it.
      streamWaitUntil: (label: string) =>
        Effect.gen(function* () {
          const record = (entry: string) =>
            journals.getByName(label).record(entry).pipe(Effect.orDie);
          const resource = yield* acquireResource(record, label);
          return Stream.fromEffect(
            Cloudflare.waitUntil(useLater(record, resource, label)).pipe(Effect.as("a")),
          );
        }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const journal = journals.getByName("default");

        // `/socket/<label>`: a WebSocket to the label's Journal.
        if (url.pathname.startsWith("/socket/")) {
          return yield* journals.getByName(url.pathname.split("/")[2] ?? "").fetch(request);
        }

        if (url.pathname.startsWith("/api/")) {
          return yield* api;
        }

        // `/stream/<target>/<mode>/<label>`: a streamed body over a resource
        // bound to the event's scope, from this Worker or a Durable Object.
        if (url.pathname.startsWith("/stream/")) {
          const [, , target, mode, label = ""] = url.pathname.split("/");
          if (!isStreamMode(mode)) return HttpServerResponse.text("Not Found", { status: 404 });
          const journal = journals.getByName(label);
          if (target === "worker") {
            const record = (entry: string) => journal.record(entry).pipe(Effect.orDie);
            const resource = yield* acquireResource(record, label);
            return HttpServerResponse.stream(resourceLines(resource, mode).pipe(Stream.encodeText));
          }
          if (target === "do-fetch") {
            const response = yield* Cloudflare.toHttpClient(journal)
              .execute(HttpClientRequest.get(`http://journal/stream/${mode}/${label}`))
              .pipe(Effect.orDie);
            return HttpServerResponse.stream(response.stream);
          }
          if (target === "do-rpc") {
            const lines = yield* journal.streamResource(label, mode);
            return HttpServerResponse.stream(lines.pipe(Stream.encodeText));
          }
          return HttpServerResponse.text("Not Found", { status: 404 });
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
          } else if (kind === "scoped-acquire") {
            // Work handed off inside a scoped region that acquires its own
            // resource: the resource lives as long as the work.
            yield* Effect.scoped(Cloudflare.waitUntil(acquireAndUseLater(record, label)));
          } else if (kind === "nested-acquire") {
            // Work that background work hands off after the handler returned.
            yield* Cloudflare.waitUntil(
              Effect.sleep("100 millis").pipe(
                Effect.andThen(Cloudflare.waitUntil(acquireAndUseLater(record, label))),
              ),
            );
          } else if (kind === "fails") {
            // A handler that fails after handing off work.
            const resource = yield* acquireResource(record, label);
            yield* Cloudflare.waitUntil(useLater(record, resource, label));
            return yield* Effect.die(new Error("handler failure"));
          } else if (kind === "queue") {
            yield* Stream.make({ label }).pipe(Stream.run(queue), Effect.orDie);
          } else if (kind === "rpc-stream" || kind === "rpc-stream-wait-until") {
            const self = yield* exec.exports.default().pipe(Effect.orDie);
            const rpc = self.raw as unknown as Record<string, (label: string) => Promise<unknown>>;
            const method = kind === "rpc-stream" ? "streamLater" : "streamWaitUntil";
            const lines = yield* decodeRpc<Stream.Stream<string>>(() => rpc[method]!(label));
            return HttpServerResponse.text((yield* Stream.runCollect(lines)).join(","));
          } else if (kind === "do-alarm") {
            return HttpServerResponse.text(yield* journal.holdAlarm(label));
          } else if (kind === "do-scoped-acquire") {
            return HttpServerResponse.text(yield* journal.holdScopedAcquire(label));
          } else if (kind === "do-fails") {
            return HttpServerResponse.text(
              yield* journal.holdFailingCall(label).pipe(
                Effect.as("succeeded"),
                Effect.catchTag("StreamFailure", () => Effect.succeed("failed")),
              ),
            );
          } else if (kind === "do-stream-wait-until") {
            const values = yield* Stream.runCollect(yield* journal.streamWaitUntil(label));
            return HttpServerResponse.text(values.join(","));
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

        // `/bg-many/<label>`: 40 concurrent background writes, read back
        // through `/lifetime/entries/<label>`.
        if (url.pathname.startsWith("/bg-many/")) {
          const journal = journals.getByName(url.pathname.split("/")[2] ?? "");
          return HttpServerResponse.text(`bg-many-${yield* journal.recordManyLater()}`);
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
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.Queues.QueueSinkBinding,
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.Workers.EmailEventSourceLive,
      ),
    ),
  ),
) {}
