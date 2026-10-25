import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as queues from "@distilled.cloud/azure/storage-queue";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import * as AzureBindings from "../AzureBindings.ts";
import { QueueEventSource as ServiceBusQueueSource } from "../ServiceBus/QueueEventSource.ts";
import { QueueEventSource as StorageQueueSource } from "../Storage/QueueEventSource.ts";
import { Job } from "./Job.ts";

/** Azure Service Bus Data Owner: the KEDA scaler reads queue counts through the admin API. */
const SERVICE_BUS_DATA_OWNER = "090c5cfd-751d-490a-894a-3ce6f1109419";

/** Messages one execution takes per receive call. */
const BATCH_SIZE = 32;

/** Receive calls one execution makes before it exits (the scaler starts more). */
const MAX_BATCHES = 10;

/** Seconds a received Storage queue message stays hidden from other executions. */
const VISIBILITY_TIMEOUT = 300;

/** KEDA rule names: lowercase letters, digits, and `-`. */
const ruleName = (prefix: string, logicalId: string) =>
  `${prefix}-${logicalId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+$/, "")
    .slice(0, 63);

/** Response headers that are not message properties. */
const HTTP_HEADERS = new Set([
  "brokerproperties",
  "content-length",
  "content-type",
  "date",
  "location",
  "server",
  "strict-transport-security",
  "transfer-encoding",
]);

/** Message text, JSON-decoded when it is JSON. */
const decodeBody = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Register `drain` as a runner of `host`, under the context its init had.
 * Handlers carry erased requirements; the captured context holds every
 * service the program's init was provided, so the cast only drops them.
 */
const runInInitContext = (
  host: { readonly run: (effect: Effect.Effect<void>) => Effect.Effect<void> },
  drain: Effect.Effect<void, never, any>,
) =>
  Effect.flatMap(Effect.context<never>(), (context) =>
    host.run(drain.pipe(Effect.provideContext(context)) as Effect.Effect<void>),
  );

/**
 * Run `handler` on a cron schedule: the job becomes a `Schedule` job with
 * `cron` (five fields, UTC), and each execution runs `handler` once. A
 * job runs on one trigger, so a job with `schedule` cannot also consume an
 * event source.
 *
 * ### Scheduling a job
 * **Example:** Every night at 02:00 UTC
 * ```typescript
 * export default class Nightly extends Azure.ContainerApps.Job<Nightly>()(
 *   "Nightly",
 *   { main: import.meta.url, environmentId },
 *   Effect.gen(function* () {
 *     yield* Azure.ContainerApps.schedule("0 2 * * *", Effect.log("nightly"));
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Every 15 minutes, writing a heartbeat blob
 * ```typescript
 * const files = yield* Azure.Storage.BlobContainerReadWrite(Heartbeats);
 * yield* Azure.ContainerApps.schedule(
 *   "*\/15 * * * *",
 *   files.put("heartbeat.txt", new Date().toISOString()).pipe(Effect.orDie),
 * );
 * ```
 *
 * @binding
 * @category ContainerApps
 */
export const schedule = <Req = never>(cron: string, handler: Effect.Effect<void, never, Req>) =>
  Effect.gen(function* () {
    const host = yield* Job;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.bind`Allow(${host}, Azure.ContainerApps.schedule(${cron}))`({ schedule: cron });
    }
    yield* runInInitContext(host, handler);
  });

/**
 * `Azure.Storage.QueueEventSource` on a Container Apps job: an `azure-queue`
 * KEDA scale rule (authenticated with the job's identity) starts an
 * execution while the queue has messages; each execution receives up to
 * 320 messages, runs the handler on each, and deletes it. A handler that
 * fails (defects) fails the execution and its message reappears after five
 * minutes. Grants **Storage Queue Data Reader** (the scaler) and **Storage
 * Queue Data Message Processor** (the program) on the queue.
 *
 * @binding
 * @category ContainerApps
 */
export const JobStorageQueueEventSource = Layer.effect(
  StorageQueueSource,
  Effect.gen(function* () {
    const host = yield* Job;
    // Resolve one at a time (see AzureBindings.withCredentials).
    const dequeue = yield* AzureBindings.withCredentials(queues.MessagesDequeue);
    const remove = yield* AzureBindings.withCredentials(queues.DeleteMessageId);
    return Effect.fn(function* (queue, _props, handler) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.ContainerApps.JobStorageQueueEventSource(${queue}))`({
          roleAssignments: [
            { roleDefinitionId: BuiltInRole.StorageQueueDataReader, scope: queue.queueId },
            {
              roleDefinitionId: BuiltInRole.StorageQueueDataMessageProcessor,
              scope: queue.queueId,
            },
          ],
          scaleRules: [
            {
              name: ruleName("queue", queue.LogicalId),
              type: "azure-queue",
              metadata: {
                accountName: queue.storageAccount,
                queueName: queue.queueName,
                queueLength: "1",
              },
              identity: "system",
            },
          ],
        });
      }
      const url = yield* Output.interpolate`https://${queue.storageAccount}.queue.core.windows.net`;
      const name = yield* queue.queueName;
      yield* runInInitContext(
        host,
        Effect.gen(function* () {
          const target = { url: yield* url, queueName: yield* name };
          for (let batch = 0; batch < MAX_BATCHES; batch++) {
            const messages = yield* dequeue({
              ...target,
              numofmessages: BATCH_SIZE,
              visibilitytimeout: VISIBILITY_TIMEOUT,
            });
            if (messages.length === 0) return;
            for (const message of messages) {
              yield* handler({
                body: decodeBody(message.MessageText),
                id: message.MessageId,
                dequeueCount: message.DequeueCount,
                insertionTime: message.InsertionTime,
                metadata: { ...message },
              });
              yield* remove({
                ...target,
                messageid: message.MessageId,
                popreceipt: message.PopReceipt,
              });
            }
          }
        }).pipe(Effect.orDie),
      );
    });
  }),
);

/**
 * `Azure.ServiceBus.QueueEventSource` on a Container Apps job: an
 * `azure-servicebus` KEDA scale rule (authenticated with the job's
 * identity) starts an execution while the queue has messages; each
 * execution receives messages (peek-lock) until the queue is empty or it
 * has taken 320, runs the handler on each, and completes it. A handler
 * that fails (defects) fails the execution; its message is redelivered
 * when the lock expires.
 *
 * Grants **Azure Service Bus Data Owner** on the queue: the KEDA scaler
 * reads the queue's message count through the Service Bus admin API, which
 * the Data Receiver role does not allow. The program itself only receives
 * and completes.
 *
 * @binding
 * @category ContainerApps
 */
export const JobServiceBusQueueEventSource = Layer.effect(
  ServiceBusQueueSource,
  Effect.gen(function* () {
    const host = yield* Job;
    // Resolve one at a time (see AzureBindings.withCredentials).
    const receive = yield* AzureBindings.withCredentials(messaging.PeekLockMessage);
    const complete = yield* AzureBindings.withCredentials(messaging.CompleteMessage);
    return Effect.fn(function* (queue, _props, handler) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Allow(${host}, Azure.ContainerApps.JobServiceBusQueueEventSource(${queue}))`(
          {
            roleAssignments: [{ roleDefinitionId: SERVICE_BUS_DATA_OWNER, scope: queue.queueId }],
            scaleRules: [
              {
                name: ruleName("sbq", queue.LogicalId),
                type: "azure-servicebus",
                metadata: {
                  namespace: queue.namespaceName,
                  queueName: queue.queueName,
                  messageCount: "1",
                },
                identity: "system",
              },
            ],
          },
        );
      }
      const namespace = yield* queue.namespaceName;
      const name = yield* queue.queueName;
      yield* runInInitContext(
        host,
        Effect.gen(function* () {
          const target = { namespaceName: yield* namespace, queueName: yield* name };
          for (let taken = 0; taken < BATCH_SIZE * MAX_BATCHES; taken++) {
            const message = yield* receive({ ...target, timeout: 5 });
            const props = message.brokerProperties;
            if (message.body === undefined || props?.lockToken === undefined) return;
            const applicationProperties: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(message.headers ?? {})) {
              if (value === undefined || HTTP_HEADERS.has(key)) continue;
              applicationProperties[key] = decodeBody(value);
            }
            yield* handler({
              body: decodeBody(new TextDecoder().decode(message.body)),
              messageId: props.messageId,
              deliveryCount: props.deliveryCount,
              enqueuedTimeUtc: props.enqueuedTimeUtc,
              applicationProperties,
              metadata: { ...props },
            });
            yield* complete({
              ...target,
              messageId: props.messageId ?? String(props.sequenceNumber ?? ""),
              lockToken: props.lockToken,
            });
          }
        }).pipe(Effect.orDie),
      );
    });
  }),
);
