import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { isWorkerEvent } from "../Workers/Worker.ts";
import type { Queue } from "./Queue.ts";

/**
 * Subscriber settings. The same shape Cloudflare's `QueueConsumer`
 * accepts. Exposed here so a single `messages(queue, props)` call
 * captures both runtime and deploy-time intent — the caller still
 * yields `Cloudflare.QueueConsumer(...)` in `alchemy.run.ts` and can
 * pass these props through to it.
 */
export interface MessagesProps {
  /** Maximum messages per batch. */
  batchSize?: number;
  /** Maximum concurrent invocations. */
  maxConcurrency?: number;
  /** Maximum delivery attempts before dead-lettering. */
  maxRetries?: number;
  /** Wait time, in ms, before flushing a partial batch. */
  maxWaitTimeMs?: number;
  /** Backoff, in seconds, applied to a retry. */
  retryDelay?: number;
}

/**
 * A single queue message handed to the subscribe handler. Mirrors
 * Cloudflare's runtime `Message<Body>` shape so per-message
 * `ack()` / `retry()` semantics match the platform docs.
 */
export type QueueMessage<Body = unknown> = cf.Message<Body>;

/**
 * Subscribe to a Cloudflare Queue with an Effect stream handler.
 *
 * Mirrors the shape of `AWS.SQS.messages(queue).subscribe(...)` but
 * runs on Cloudflare's push model — the underlying Worker registers
 * a `queue` event listener that pipes each batch through the
 * user-supplied `process` function.
 *
 * Acking semantics: if `process` succeeds, every message in the
 * batch is `ack()`ed. If it fails, every message is `retry()`ed —
 * Cloudflare applies `maxRetries` and `retryDelay` from the
 * consumer settings, eventually dead-lettering. Per-message acking
 * is still available by calling `msg.ack()` / `msg.retry()` inside
 * the handler.
 *
 * **Deploy-time wiring is separate.** This call only registers the
 * runtime listener; you still yield `Cloudflare.QueueConsumer(...)`
 * in `alchemy.run.ts` so Cloudflare knows to dispatch messages
 * from the queue to this Worker.
 *
 * @example
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Stream from "effect/Stream";
 *
 * yield* Cloudflare.messages<MyEvent>(Queue).subscribe((stream) =>
 *   Stream.runForEach(stream, (msg) =>
 *     Effect.log(`event ${msg.body.id}`),
 *   ),
 * );
 * ```
 */
export const messages = <Body = unknown>(
  queue: Queue,
  props: MessagesProps = {},
) => ({
  subscribe: <Req = never>(
    process: (
      stream: Stream.Stream<QueueMessage<Body>>,
    ) => Effect.Effect<void, unknown, Req>,
  ) =>
    QueueEventSource.use((source) =>
      source<Body, Req>(queue, props, process),
    ),
});

// `Req` is the handler's requirements. The service registers the
// handler with the Worker's runtime context, where the runtime
// machinery provides bindings, `WorkerEnvironment`, etc. when the
// dispatch fires — so the requirement is satisfied at handler
// invocation, NOT at subscribe time. We drop `Req` from the return
// to keep init effects clean (mirrors `AWS.SQS.QueueEventSourceService`).
export type QueueEventSourceService = <Body = unknown, Req = never>(
  queue: Queue,
  props: MessagesProps,
  process: (
    stream: Stream.Stream<QueueMessage<Body>>,
  ) => Effect.Effect<void, unknown, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Service tag for the Cloudflare Queue event source. Provided by
 * {@link QueueEventSourceLive} on the Worker's runtime layer.
 */
export class QueueEventSource extends Context.Service<
  QueueEventSource,
  QueueEventSourceService
>()("Cloudflare.Queue.QueueEventSource") {}

/**
 * Runtime layer for {@link messages}. Wires each
 * `messages(queue).subscribe(...)` call in the Worker init phase to
 * a `queue` event listener on the runtime context.
 *
 * Provide alongside other Cloudflare runtime layers (e.g.
 * `QueueBindingLive`) on the Worker effect.
 */
export const QueueEventSourceLive = Layer.succeed(
  QueueEventSource,
  // The service body resolves `RuntimeContext` per-call rather than
  // at layer construction. Capturing it on the layer would leak the
  // requirement past `PlatformServices` exclusion when the Worker
  // typechecks its init effect (the Worker's init scope does
  // provide `RuntimeContext`, so resolving here is sound).
  Effect.fn(function* <Body, Req>(
    queue: Queue,
    _props: MessagesProps,
    process: (
      stream: Stream.Stream<QueueMessage<Body>>,
    ) => Effect.Effect<void, unknown, Req>,
  ) {
    const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
    // Capture the queue-name accessor once; the listener body
    // re-resolves it per event via `yield* QueueName`. A worker
    // can consume multiple queues — each subscribe registers its
    // own listener and they all see every queue event, so the
    // queue-name match is what scopes the handler.
    const QueueName = yield* queue.queueName;

    yield* ctx.listen<void, Req>((event) => {
      if (!isWorkerEvent(event) || event.type !== "queue") return;
      const batch = event.input as cf.MessageBatch<Body>;

      return Effect.gen(function* () {
        const queueName = yield* QueueName;
        if (batch.queue !== queueName) return;

        yield* process(Stream.fromIterable(batch.messages)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              for (const msg of batch.messages) msg.ack();
            }),
          ),
          Effect.onError((cause) =>
            Effect.sync(() => {
              // Surface the failure so the operator sees what
              // tripped the retry path; without this the only
              // signal is the message reappearing on the next
              // attempt.
              console.error(
                `[QueueEventSource] handler failed on queue ` +
                  `"${queueName}": ${Cause.pretty(cause)}`,
              );
              for (const msg of batch.messages) msg.retry();
            }),
          ),
          Effect.catchCause(() => Effect.void),
        );
      });
    });
  }) as QueueEventSourceService,
);
