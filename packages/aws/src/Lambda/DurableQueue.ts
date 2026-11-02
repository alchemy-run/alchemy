import * as DurableQueues from "alchemy/DurableQueues";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { PersistedQueueError, PersistedQueueFactory } from "effect/persistence/PersistedQueue";
import * as Schedule from "effect/Schedule";
import type { WorkflowEngine } from "effect/workflow";
import { GetItem } from "../DynamoDB/GetItem.ts";
import { GetItemHttp } from "../DynamoDB/GetItemHttp.ts";
import { PutItem } from "../DynamoDB/PutItem.ts";
import { PutItemHttp } from "../DynamoDB/PutItemHttp.ts";
import { Table } from "../DynamoDB/Table.ts";
import { UpdateItem } from "../DynamoDB/UpdateItem.ts";
import { UpdateItemHttp } from "../DynamoDB/UpdateItemHttp.ts";
import type { Queue } from "../SQS/Queue.ts";
import { consumeQueueMessages, type MessagesProps } from "../SQS/QueueEventSource.ts";
import { SendMessage } from "../SQS/SendMessage.ts";
import { SendMessageHttp } from "../SQS/SendMessageHttp.ts";
import { QueueEventSource } from "./QueueEventSource.ts";
import { CurrentRun } from "./WorkflowFunction.ts";

/**
 * Run Effect's `DurableQueue` items on an SQS queue: provide this to the
 * {@link WorkflowFunction} that hosts the workflows, and
 * `DurableQueue.process` sends its items there.
 *
 * Each item is offered once, however often its workflow replays, by a
 * ledger table it declares for the queue. Consume the queue with
 * {@link DurableQueueWorker} on a function that provides
 * `DurableFunctionEngine` for the host, which the worker completes items
 * through.
 *
 * ### Processing items on a queue
 * **Example:** A workflow function that charges through a queue
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
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
 * export const Charges = AWS.SQS.Queue("Charges");
 *
 * export class CheckoutWorkflows extends AWS.Lambda.WorkflowFunction<CheckoutWorkflows>()(
 *   "CheckoutWorkflows",
 *   { workflows: [Checkout] },
 * ) {}
 *
 * export default CheckoutWorkflows.make(
 *   { main: import.meta.url },
 *   Layer.unwrap(
 *     Effect.map(Charges, (charges) =>
 *       Workflows.layer(
 *         Checkout,
 *         Effect.fn(function* ({ orderId }) {
 *           return yield* DurableQueue.process(Charge, { orderId, amount: 42 });
 *         }),
 *       ).pipe(Layer.provide(AWS.Lambda.DurableQueueProducer(charges))),
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides PersistedQueueFactory
 * @product Lambda
 */
export const DurableQueueProducer = (queue: Queue) =>
  Layer.effect(
    PersistedQueueFactory,
    Effect.gen(function* () {
      const ledger = yield* makeLedger(queue);
      const send = yield* SendMessage(queue);
      const offer = DurableQueues.offerOnce(ledger, (envelope) =>
        send({ MessageBody: JSON.stringify(envelope) }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            PersistedQueueError.make({ message: "Sending a DurableQueue item failed", cause }),
          ),
        ),
      );
      return DurableQueues.makeFactory((envelope) =>
        Effect.gen(function* () {
          // In a run, the item is sent when the run starts waiting for it.
          // `DurableQueue.process` waits on the deferred named after the item.
          const run = yield* Effect.serviceOption(CurrentRun);
          if (Option.isNone(run)) return yield* offer(envelope);
          // The submitter runs outside the run's fiber: send with its services.
          const context = yield* Effect.context<never>();
          run.value.offers.set(
            DurableQueues.ledgerKey(envelope),
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the run's own context, captured here, provides RuntimeContext
            offer(envelope).pipe(
              // As `DurableQueue.process` retries an offer that fails.
              Effect.retry({
                schedule: Schedule.min([
                  Schedule.exponential("200 millis"),
                  Schedule.spaced("5 seconds"),
                ]),
                times: 8,
              }),
              Effect.orDie,
              Effect.provide(context),
            ) as Effect.Effect<void>,
          );
        }),
      );
    }),
  ).pipe(Layer.provide(Layer.mergeAll(LedgerHttp, SendMessageHttp)));

/**
 * Consume an SQS queue that {@link DurableQueueProducer} sends Effect
 * `DurableQueue` items to: run each item's handler and complete the waiting
 * workflow with its exit. Lambda delivers the items, so nothing polls.
 *
 * Provide it on a Lambda function together with `DurableFunctionEngine` for
 * the function that hosts the workflows. A handler's typed failure or defect
 * is the workflow's result for the item, as with `DurableQueue.worker`. An
 * item a worker already completed is not run again when SQS redelivers it. A
 * message that fails for any other reason is retried by SQS, and moves to the
 * queue's dead-letter queue once its `maxReceiveCount` is spent; its workflow
 * keeps waiting.
 *
 * ### Consuming items
 * **Example:** A function that handles the charge queue
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as DurableQueues from "alchemy/DurableQueues";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Charge, Charges, CheckoutWorkflows } from "./checkout.ts";
 *
 * export class ChargeWorker extends AWS.Lambda.Function<ChargeWorker>()("ChargeWorker") {}
 *
 * export default ChargeWorker.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const charges = yield* Charges;
 *     // Building the Layer registers the consumer.
 *     yield* Effect.void.pipe(
 *       Effect.provide(
 *         AWS.Lambda.DurableQueueWorker(charges, [
 *           DurableQueues.handler(Charge, ({ amount }) => Effect.succeed(`charged ${amount}`)),
 *         ]).pipe(Layer.provide(AWS.Lambda.DurableFunctionEngine(CheckoutWorkflows))),
 *       ),
 *     );
 *   }),
 * );
 * ```
 *
 * @layer
 * @product Lambda
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
      const ledger = yield* makeLedger(queue);
      // The handlers' services, captured now: the queue listener runs them.
      // RuntimeContext comes with each delivery.
      const services = yield* Effect.context<
        | WorkflowEngine.WorkflowEngine
        | Exclude<DurableQueues.HandlerServices<Handlers>, RuntimeContext>
      >();
      yield* consumeQueueMessages(
        queue,
        props,
        Effect.fn(function* (event) {
          // A message that fails is retried by SQS; the rest are deleted.
          const failed = yield* Effect.filter(
            event.Records,
            (record) =>
              Effect.try(() => JSON.parse(record.body) as unknown).pipe(
                Effect.flatMap((body) => DurableQueues.deliver(handlers, ledger, body)),
                Effect.provide(services),
                Effect.as(false),
                Effect.catchCause((cause) =>
                  Effect.logError("DurableQueue item failed; SQS retries it", cause).pipe(
                    Effect.as(true),
                  ),
                ),
              ),
            { concurrency: "unbounded" },
          );
          return {
            batchItemFailures: failed.map((record) => ({ itemIdentifier: record.messageId })),
          };
        }),
      );
    }),
  ).pipe(Layer.provide(Layer.mergeAll(LedgerHttp, QueueEventSource)));

// ---------------------------------------------------------------- the ledger

const LedgerHttp = Layer.mergeAll(GetItemHttp, PutItemHttp, UpdateItemHttp);

/**
 * The queue's ledger: one item per queue item, whose `state` is `offered`,
 * `sent` or `completed`. The producer and the worker both declare it.
 */
const makeLedger = (queue: Queue) =>
  Effect.gen(function* () {
    const table = yield* Table(`${queue.LogicalId}DurableQueueLedger`, {
      partitionKey: "id",
      attributes: { id: "S" },
    });
    const getItem = yield* GetItem(table);
    const putItem = yield* PutItem(table);
    const updateItem = yield* UpdateItem(table);
    const failed = (cause: unknown) =>
      PersistedQueueError.make({ message: "DurableQueue ledger call failed", cause });
    const keyOf = (envelope: DurableQueues.Envelope) => ({
      id: { S: DurableQueues.ledgerKey(envelope) },
    });
    const stateOf = (envelope: DurableQueues.Envelope) =>
      getItem({ Key: keyOf(envelope), ConsistentRead: true }).pipe(
        Effect.map(({ Item }) => Item?.state?.S),
        Effect.mapError(failed),
      );
    const ledger: DurableQueues.Ledger = {
      // An item offered but not yet sent is sent again: the earlier send may
      // not have happened.
      claim: (envelope) =>
        putItem({
          Item: { ...keyOf(envelope), state: { S: "offered" } },
          ConditionExpression: "attribute_not_exists(id)",
        }).pipe(
          Effect.as(true),
          Effect.catchTag("ConditionalCheckFailedException", () =>
            Effect.map(stateOf(envelope), (state) => state === "offered"),
          ),
          Effect.mapError(failed),
        ),
      sent: (envelope) =>
        updateItem({
          Key: keyOf(envelope),
          UpdateExpression: "SET #state = :sent",
          ConditionExpression: "#state <> :completed",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":sent": { S: "sent" }, ":completed": { S: "completed" } },
        }).pipe(
          Effect.asVoid,
          Effect.catchTag("ConditionalCheckFailedException", () => Effect.void),
          Effect.mapError(failed),
        ),
      completed: (envelope) => Effect.map(stateOf(envelope), (state) => state === "completed"),
      complete: (envelope) =>
        putItem({ Item: { ...keyOf(envelope), state: { S: "completed" } } }).pipe(
          Effect.asVoid,
          Effect.mapError(failed),
        ),
    };
    return ledger;
  });
