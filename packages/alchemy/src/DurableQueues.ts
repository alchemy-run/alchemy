/**
 * Run Effect's `DurableQueue` on a cloud's native queue.
 *
 * A workflow keeps `DurableQueue.process`: it offers the item through a
 * `PersistedQueueFactory` and waits for the result. A cloud's producer Layer
 * provides that factory over its native queue (Cloudflare Queues, SQS) and a
 * ledger that offers each item once however often the workflow replays. Its
 * worker Layer consumes the native queue, runs the matching {@link handler},
 * and completes the workflow's wait with the handler's exit. The platform
 * delivers the items, so nothing polls, and it all runs on Workers and Lambda.
 *
 * These are the cloud-agnostic pieces each cloud's Layers share.
 *
 * @module
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PersistedQueue from "effect/persistence/PersistedQueue";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import type { DurableQueue } from "effect/workflow";
import { DurableDeferred, type WorkflowEngine } from "effect/workflow";
import type { RuntimeContext } from "./RuntimeContext.ts";

/** What a native queue message carries: one `DurableQueue` item. */
export const Envelope = Schema.Struct({
  /** The `PersistedQueue` name, `DurableQueue/<name>`. */
  queue: Schema.String,
  /** The item's id, stable across the workflow's replays. */
  id: Schema.String,
  /** The item, encoded with its queue's schema. */
  element: Schema.Unknown,
});
export type Envelope = typeof Envelope.Type;

/** The `PersistedQueue` name Effect gives a `DurableQueue`. */
export const queueNameOf = (queue: DurableQueue.DurableQueue<any, any, any>) =>
  `DurableQueue/${queue.name}`;

/**
 * Offer an item to the native queue, once: an offer with an id already
 * offered does nothing. The workflow re-offers on every replay until its item
 * is done.
 */
export type Offer = (
  envelope: Envelope,
) => Effect.Effect<void, PersistedQueue.PersistedQueueError, RuntimeContext>;

/**
 * A `PersistedQueueFactory` whose queues offer through `offer`. Taking is the
 * native queue's consumer's job, so `take` dies.
 */
export const makeFactory = (offer: Offer): PersistedQueue.PersistedQueueFactory["Service"] =>
  PersistedQueue.PersistedQueueFactory.of({
    make: ({ name, schema }) =>
      Effect.succeed({
        [PersistedQueue.TypeId]: PersistedQueue.TypeId,
        offer: (value, options) =>
          Effect.gen(function* () {
            const element = yield* Schema.encodeEffect(schema)(value);
            const id = options?.id ?? (yield* Effect.sync(() => crypto.randomUUID()));
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- a workflow offers from inside its run, which provides RuntimeContext
            yield* offer({ queue: name, id, element }) as Effect.Effect<
              void,
              PersistedQueue.PersistedQueueError
            >;
            return id;
          }),
        take: () =>
          Effect.die(
            new Error(
              `PersistedQueue "${name}" is consumed by its native queue's worker Layer, not by take`,
            ),
          ),
      } as PersistedQueue.PersistedQueue<any, any>),
  });

/** The item `DurableQueue.process` offers, around its encoded payload. */
const Item = Schema.Struct({
  token: DurableDeferred.Token,
  traceId: Schema.String,
  spanId: Schema.String,
  sampled: Schema.Boolean,
  payload: Schema.Unknown,
});

/**
 * A worker for one `DurableQueue`: what runs each of its items. Pass handlers
 * to a cloud's worker Layer.
 */
export interface Handler<R = never> {
  /** The `PersistedQueue` name it handles. */
  readonly queue: string;
  /**
   * Run one item, encoded, and complete the workflow's wait with the
   * handler's exit. Fails only when the item can't be decoded.
   */
  readonly run: (
    element: unknown,
  ) => Effect.Effect<void, Schema.SchemaError, WorkflowEngine.WorkflowEngine | RuntimeContext | R>;
}

/**
 * Handle a `DurableQueue`'s items with `f`. Like `DurableQueue.worker`, the
 * handler's exit, success, typed failure or defect, is the workflow's result
 * for the item.
 *
 * ### Handling a queue
 * **Example:** A worker for the charge queue
 * ```typescript
 * import * as DurableQueues from "alchemy/DurableQueues";
 * import * as Effect from "effect/Effect";
 * import { Charge } from "./queues.ts";
 *
 * export const ChargeHandler = DurableQueues.handler(Charge, ({ amount }) =>
 *   Effect.succeed(`charged ${amount}`),
 * );
 * ```
 *
 * @primitive
 */
export const handler = <
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R = never,
>(
  queue: DurableQueue.DurableQueue<Payload, Success, Error>,
  f: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>,
): Handler<
  R | Payload["DecodingServices"] | Success["EncodingServices"] | Error["EncodingServices"]
> => ({
  queue: queueNameOf(queue),
  run: Effect.fn(function* (element: unknown) {
    const decoded = yield* Schema.decodeUnknownEffect(Item)(element);
    const payload = yield* Schema.decodeUnknownEffect(queue.payloadSchema)(decoded.payload);
    yield* f(payload).pipe(
      Effect.exit,
      Effect.flatMap((exit: Exit.Exit<Success["Type"], Error["Type"]>) =>
        DurableDeferred.done(queue.deferred, { token: decoded.token, exit }),
      ),
      Effect.withSpan(`DurableQueue/${queue.name}/worker`, {
        parent: Tracer.externalSpan({
          traceId: decoded.traceId,
          spanId: decoded.spanId,
          sampled: decoded.sampled,
        }),
      }),
    );
  }),
});

/**
 * Record of an item's progress: offered once, sent to the native queue, then
 * completed. Each cloud keeps one per item in its own storage.
 */
export interface Ledger {
  /** Record an offer. `true` when the item still needs sending. */
  readonly claim: (
    envelope: Envelope,
  ) => Effect.Effect<boolean, PersistedQueue.PersistedQueueError, RuntimeContext>;
  /** The item reached the native queue. */
  readonly sent: (
    envelope: Envelope,
  ) => Effect.Effect<void, PersistedQueue.PersistedQueueError, RuntimeContext>;
  /** Whether a worker already completed the item. */
  readonly completed: (
    envelope: Envelope,
  ) => Effect.Effect<boolean, PersistedQueue.PersistedQueueError, RuntimeContext>;
  /** A worker completed the item: a redelivery of it does nothing. */
  readonly complete: (
    envelope: Envelope,
  ) => Effect.Effect<void, PersistedQueue.PersistedQueueError, RuntimeContext>;
}

/** Offer through a ledger: claim, send, and record that it's sent. */
export const offerOnce =
  (
    ledger: Ledger,
    send: (
      envelope: Envelope,
    ) => Effect.Effect<void, PersistedQueue.PersistedQueueError, RuntimeContext>,
  ): Offer =>
  (envelope) =>
    Effect.gen(function* () {
      if (!(yield* ledger.claim(envelope))) return;
      yield* send(envelope);
      yield* ledger.sent(envelope);
    });

/**
 * Deliver one native queue message: skip an item already completed, run its
 * queue's handler, and record it completed. A message no handler claims, or
 * whose item can't be decoded, can never be processed: it is logged and
 * dropped, as Effect dead-letters an undecodable item. Any other failure is
 * left to the native queue to redeliver.
 */
export const deliver = Effect.fn(function* <R>(
  handlers: ReadonlyArray<Handler<R>>,
  ledger: Ledger,
  body: unknown,
) {
  const envelope = yield* Schema.decodeUnknownEffect(Envelope)(body).pipe(Effect.option);
  if (envelope._tag === "None") {
    return yield* Effect.logError("DurableQueue message isn't an item; dropped", body);
  }
  const handle = handlers.find((handler) => handler.queue === envelope.value.queue);
  if (!handle) {
    return yield* Effect.logError(`No DurableQueue handler for ${envelope.value.queue}; dropped`);
  }
  if (yield* ledger.completed(envelope.value)) return;
  const ran = yield* handle.run(envelope.value.element).pipe(Effect.exit);
  if (Exit.isFailure(ran)) {
    return yield* Effect.logError(
      `DurableQueue item ${envelope.value.id} can't be decoded; dropped`,
      ran.cause,
    );
  }
  yield* ledger.complete(envelope.value);
});

/** The services a {@link Handler} list needs. */
export type HandlerServices<H extends ReadonlyArray<Handler<any>>> =
  H[number] extends Handler<infer R> ? R : never;

/** A ledger keyed by queue and id. */
export const ledgerKey = (envelope: Pick<Envelope, "queue" | "id">) =>
  `${envelope.queue}/${envelope.id}`;
