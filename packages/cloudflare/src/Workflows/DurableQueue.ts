import * as DurableQueues from "alchemy/DurableQueues";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PersistedQueueError, PersistedQueueFactory } from "effect/persistence/PersistedQueue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { WorkflowEngine } from "effect/workflow";
import {
  consumeQueueMessages,
  EventSourceLive,
  type MessagesProps,
} from "../Queues/EventSource.ts";
import type { Queue } from "../Queues/Queue.ts";
import { WriteQueue } from "../Queues/WriteQueue.ts";
import { WriteQueueBinding } from "../Queues/WriteQueueBinding.ts";
import { DurableObject as CloudflareDurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import type { Worker } from "../Workers/Worker.ts";

/**
 * Run Effect's `DurableQueue` items on a Cloudflare Queue: provide this next
 * to the workflow Layers, and `DurableQueue.process` sends its items there.
 *
 * Each item is offered once, however often its workflow replays, by a
 * ledger kept in a Durable Object on the Worker. Consume the queue with
 * {@link DurableQueueWorker} on the same Worker, which also hosts the
 * workflow engine that the worker completes items through.
 *
 * ### Processing items on a queue
 * **Example:** A workflow that charges through a queue
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as DurableQueues from "alchemy/DurableQueues";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
 * import * as Schema from "effect/Schema";
 * import { DurableQueue, Workflow } from "effect/workflow";
 *
 * export const Charge = DurableQueue.make({
 *   name: "Charge",
 *   payload: { orderId: Schema.String, amount: Schema.Number },
 *   success: Schema.String,
 *   idempotencyKey: ({ orderId }) => orderId,
 * });
 *
 * export const Checkout = Workflow.make("Checkout", {
 *   payload: { orderId: Schema.String },
 *   success: Schema.String,
 *   idempotencyKey: ({ orderId }) => orderId,
 * });
 *
 * const CheckoutLive = Workflows.layer(
 *   Checkout,
 *   Effect.fn(function* ({ orderId }) {
 *     return yield* DurableQueue.process(Charge, { orderId, amount: 42 });
 *   }),
 * );
 *
 * export default class App extends Cloudflare.Worker<App>()(
 *   "App",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const charges = yield* Cloudflare.Queues.Queue("Charges");
 *     const checkout = yield* Workflows.RunWorkflow(Checkout);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* checkout.start({ orderId: "o-1" });
 *         return yield* HttpServerResponse.json({ executionId: run.executionId });
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         CheckoutLive,
 *         Cloudflare.Workflows.DurableQueueWorker(charges, [
 *           DurableQueues.handler(Charge, ({ amount }) => Effect.succeed(`charged ${amount}`)),
 *         ]),
 *       ).pipe(
 *         Layer.provideMerge(
 *           Layer.mergeAll(
 *             Cloudflare.Workflows.layerDurableObjectEngine(),
 *             Cloudflare.Workflows.DurableQueueProducer(charges),
 *           ),
 *         ),
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @layer
 * @provides PersistedQueueFactory
 * @product Workflows
 */
export const DurableQueueProducer = (queue: Queue) =>
  Layer.effect(
    PersistedQueueFactory,
    Effect.gen(function* () {
      const writer = yield* WriteQueue(queue);
      const ledger = yield* declareLedger(queue);
      return DurableQueues.makeFactory(
        DurableQueues.offerOnce(ledger, (envelope) =>
          writer
            .send(envelope)
            .pipe(
              Effect.mapError((cause) =>
                PersistedQueueError.make({ message: cause.message, cause }),
              ),
            ),
        ),
      );
    }),
  ).pipe(Layer.provide(WriteQueueBinding));

/**
 * Consume a Cloudflare Queue that {@link DurableQueueProducer} sends Effect
 * `DurableQueue` items to: run each item's handler and complete the waiting
 * workflow with its exit. Cloudflare delivers the items, so nothing polls.
 *
 * Provide it on the Worker that hosts the workflow engine, with the engine
 * below it. A handler's typed failure or defect is the workflow's result for
 * the item, as with `DurableQueue.worker`. An item a worker already completed
 * is not run again when Cloudflare redelivers it. A batch that fails for any
 * other reason is retried by the queue, up to `maxRetries`, then sent to
 * `deadLetterQueue`; its workflow keeps waiting.
 *
 * ### Consuming items
 * **Example:** Handle the charge queue, dead-lettering after three tries
 * ```typescript
 * const deadLetters = yield* Cloudflare.Queues.Queue("ChargeDeadLetters");
 *
 * Cloudflare.Workflows.DurableQueueWorker(
 *   charges,
 *   [DurableQueues.handler(Charge, ({ amount }) => Effect.succeed(`charged ${amount}`))],
 *   { maxRetries: 3, deadLetterQueue: deadLetters },
 * );
 * ```
 *
 * @layer
 * @product Workflows
 */
export const DurableQueueWorker = <
  const Handlers extends ReadonlyArray<DurableQueues.Handler<any>>,
>(
  queue: Queue,
  handlers: Handlers,
  props: MessagesProps = {},
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const ledger = yield* declareLedger(queue);
      // The handlers' services, captured now: the queue listener runs them.
      // RuntimeContext comes with each delivery.
      const services = yield* Effect.context<
        | WorkflowEngine.WorkflowEngine
        | Exclude<DurableQueues.HandlerServices<Handlers>, RuntimeContext>
      >();
      yield* consumeQueueMessages(queue, props, (stream) =>
        Stream.runForEach(stream, (message) =>
          DurableQueues.deliver(handlers, ledger, message.body).pipe(Effect.provide(services)),
        ),
      );
    }),
  ).pipe(Layer.provide(EventSourceLive));

// ---------------------------------------------------------------- the ledger

/** Where an item is: offered and not yet sent, sent, or completed. */
type ItemState = "offered" | "sent" | "completed";

/** One item's ledger, a Durable Object named after its queue and id. */
const ledgerObject = Effect.gen(function* () {
  const state = yield* DurableObjectState;
  return Effect.gen(function* () {
    const read = state.storage.get<ItemState>("state");
    const write = (next: ItemState) => state.storage.put("state", next);
    return {
      // An item offered but not yet sent is sent again: the earlier send may
      // not have happened.
      claim: () =>
        Effect.gen(function* () {
          const current = yield* read;
          if (current === undefined) yield* write("offered");
          return current === undefined || current === "offered";
        }),
      sent: () =>
        Effect.gen(function* () {
          if ((yield* read) !== "completed") yield* write("sent");
        }),
      completed: () => Effect.map(read, (current) => current === "completed"),
      complete: () => write("completed"),
    };
  });
});

interface LedgerStub {
  readonly claim: () => Effect.Effect<unknown, unknown>;
  readonly sent: () => Effect.Effect<unknown, unknown>;
  readonly completed: () => Effect.Effect<unknown, unknown>;
  readonly complete: () => Effect.Effect<unknown, unknown>;
}

const declare = CloudflareDurableObject as unknown as (
  name: string,
  impl: Effect.Effect<
    Effect.Effect<
      Record<string, unknown>,
      never,
      DurableObjectState | RuntimeContext | Scope.Scope
    >,
    never,
    DurableObjectState
  >,
) => Effect.Effect<{ readonly getByName: (name: string) => LedgerStub }, never, Worker>;

/**
 * The queue's ledger class on the host Worker. The producer and the worker
 * both declare it, with the same implementation.
 */
const declareLedger = (queue: Queue) =>
  Effect.map(
    declare(`${queue.LogicalId}DurableQueueLedger`, ledgerObject),
    (namespace): DurableQueues.Ledger => {
      const call = <A>(envelope: DurableQueues.Envelope, method: keyof LedgerStub) =>
        Effect.suspend(() => namespace.getByName(DurableQueues.ledgerKey(envelope))[method]()).pipe(
          Effect.mapError((cause) =>
            PersistedQueueError.make({ message: "DurableQueue ledger call failed", cause }),
          ),
          Effect.map((value) => value as A),
        );
      return {
        claim: (envelope) => call<boolean>(envelope, "claim"),
        sent: (envelope) => Effect.asVoid(call(envelope, "sent")),
        completed: (envelope) => call<boolean>(envelope, "completed"),
        complete: (envelope) => Effect.asVoid(call(envelope, "complete")),
      };
    },
  );
