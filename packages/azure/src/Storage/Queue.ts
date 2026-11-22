import * as storage from "@distilled.cloud/azure/storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  tagsDiffer,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createStorageChildName,
  isOwnedByMetadata,
  ownershipMetadata,
  userMetadata,
} from "./StorageOwnership.ts";

export interface QueueProps {
  /**
   * Resource group of the storage account. Changing it replaces the queue.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Storage account that holds the queue. Changing it replaces the queue. */
  storageAccount: string;
  /**
   * Queue name: 3-63 lowercase letters, digits, and single hyphens,
   * starting and ending with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * queue.
   */
  name?: string;
  /**
   * User metadata (letters, digits, and `_` in keys). Alchemy ownership
   * markers (`alchemy_stack`, `alchemy_stage`, `alchemy_id`) are merged in
   * because queues have no tags.
   * @default {}
   */
  metadata?: Record<string, string>;
}

export interface Queue extends Resource<
  "Azure.Storage.Queue",
  QueueProps,
  {
    /** Name of the queue. */
    queueName: string;
    /** Storage account that holds the queue. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the queue; use it as a role-assignment scope. */
    queueId: string;
    /** User metadata (Alchemy ownership markers stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Storage queue (`Microsoft.Storage/storageAccounts/queueServices/queues`):
 * a simple, durable message queue inside a Storage account. Messages are
 * text up to 64 KiB and live for 7 days unless you set a time to live.
 *
 * Use it to hand work from an API to a background worker. For sessions,
 * topics, dead-letter queues, or larger messages, use
 * `Azure.ServiceBus.Queue`. Queues cannot be tagged, so Alchemy records
 * ownership in queue metadata (`alchemy_stack`, `alchemy_stage`,
 * `alchemy_id`).
 *
 * :::caution[Changing `name`, `storageAccount`, or `resourceGroup` replaces the queue]
 * Alchemy creates a new, empty queue and deletes the old one with every
 * message in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/storage/queues/storage-queues-introduction
 *
 * ### Creating a Queue
 * **Example:** Basic queue
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("app");
 * const jobs = yield* Azure.Storage.Queue("jobs", {
 *   storageAccount: account.storageAccountName,
 * });
 * ```
 *
 * **Example:** Queue with a fixed name and metadata
 * ```typescript
 * const jobs = yield* Azure.Storage.Queue("jobs", {
 *   storageAccount: account.storageAccountName,
 *   name: "background-jobs",
 *   metadata: { purpose: "background_jobs" },
 * });
 * ```
 *
 * ### Binding to a runtime
 * Each binding grants the smallest role on this queue only:
 *
 * | Binding | Role | Client |
 * | --- | --- | --- |
 * | `QueueSend` | Storage Queue Data Message Sender | `send` |
 * | `QueueReceive` | Storage Queue Data Message Processor | `receive`, `delete`, `peek` |
 * | `QueueRead` | Storage Queue Data Reader | `peek`, `getProperties` |
 * | `QueueWrite` | custom: `messages/write`, `messages/delete`, `messages/process/action` | `send`, `update`, `delete`, `clear` |
 * | `QueueReadWrite` | custom: `queues/read` plus `messages/read`, `write`, `delete`, `process/action` | every method above |
 *
 * On an Azure Function, Web App, Container App, container group, or VM the
 * role goes to the host's managed identity. On any other host (a Cloudflare
 * Worker, an AWS Lambda) Alchemy creates an Entra service principal for it.
 *
 * **Example:** Enqueue jobs from an API
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const jobsQueue = yield* Jobs;
 *     const jobs = yield* Azure.Storage.QueueSend(jobsQueue);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const id = crypto.randomUUID();
 *         yield* jobs.send(JSON.stringify({ id, payload: "hello" }));
 *         return yield* HttpServerResponse.json({ id }, { status: 202 });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.QueueSendHttp)),
 * ) {}
 * ```
 *
 * **Example:** Send from a Cloudflare Worker
 * ```typescript
 * // init: an Entra service principal for the Worker gets the Sender role
 * const send = yield* Azure.Storage.QueueSend(jobs);
 *
 * // runtime
 * yield* send.send("from-worker");
 * // …provided with Effect.provide(Azure.Storage.QueueSendHttp)
 * ```
 *
 * ### Runtime Operations
 * **Example:** Send a delayed message that expires in an hour
 * ```typescript
 * const { messageId } = yield* jobs.send(JSON.stringify({ id }), {
 *   visibilityTimeoutSeconds: 30,
 *   timeToLiveSeconds: 3600,
 * });
 * ```
 *
 * **Example:** Receive a batch and delete what you handled
 * ```typescript
 * // init
 * const jobs = yield* Azure.Storage.QueueReceive(queue);
 *
 * // runtime
 * const messages = yield* jobs.receive({ maxMessages: 16, visibilityTimeoutSeconds: 60 });
 * for (const message of messages) {
 *   yield* Effect.log(JSON.parse(message.text));
 *   yield* jobs.delete(message);
 * }
 * // …provided with Effect.provide(Azure.Storage.QueueReceiveHttp)
 * ```
 *
 * **Example:** Read the backlog without dequeuing
 * ```typescript
 * // init
 * const monitor = yield* Azure.Storage.QueueRead(queue);
 *
 * // runtime
 * const { approximateMessageCount } = yield* monitor.getProperties();
 * const [next] = yield* monitor.peek();
 * // …provided with Effect.provide(Azure.Storage.QueueReadHttp)
 * ```
 *
 * **Example:** Retry a message later, or clear the queue
 * ```typescript
 * // init
 * const jobs = yield* Azure.Storage.QueueReadWrite(queue);
 *
 * // runtime
 * const [message] = yield* jobs.receive();
 * if (message) yield* jobs.update(message, { text: message.text, visibilityTimeoutSeconds: 300 });
 * yield* jobs.clear();
 * // …provided with Effect.provide(Azure.Storage.QueueReadWriteHttp)
 * ```
 *
 * ### Event Sources
 * `consumeQueueMessages` runs a handler for every message. Provide the
 * layer for your host; each grants the roles its consumer needs on the
 * queue.
 *
 * **Example:** Azure Function worker (`queueTrigger`)
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Azure.Storage.consumeQueueMessages(Jobs, (message) =>
 *       Effect.log(`job ${message.id}: ${JSON.stringify(message.body)}`),
 *     );
 *   }).pipe(Effect.provide(Azure.Functions.StorageQueueEventSource)),
 * ) {}
 * ```
 *
 * The Functions host delivers one message per invocation and decodes JSON
 * bodies. A handler that fails makes the host retry the message; after
 * five dequeues it moves to `<queue>-poison`.
 *
 * **Example:** Container App consumer that scales on queue length
 * ```typescript
 * yield* Azure.Storage.consumeQueueMessages(jobs, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Effect.provide(Azure.ContainerApps.AppStorageQueueEventSource)
 * ```
 *
 * **Example:** Container Apps job started while the queue has messages
 * ```typescript
 * yield* Azure.Storage.consumeQueueMessages(jobs, (message) =>
 *   Effect.log(message.body),
 * );
 * // …provided with Effect.provide(Azure.ContainerApps.JobStorageQueueEventSource)
 * ```
 *
 * ### Deleting a Queue
 * Destroying the queue deletes every message in it.
 *
 * **Example:** Keep the queue when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const jobs = yield* Azure.Storage.Queue("jobs", {
 *   storageAccount: account.storageAccountName,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Queue = GroupedResource<Queue>("Azure.Storage.Queue", { local: true });

const getQueue = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  queueName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetQueue({
      subscriptionId,
      resourceGroupName,
      accountName,
      queueName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  queue: storage.GetQueueResponse,
): Queue["Attributes"] => ({
  queueName: name,
  storageAccount,
  resourceGroup,
  queueId: queue.id ?? "",
  metadata: userMetadata(queue.properties?.metadata),
});

export const QueueProvider = () =>
  Provider.succeed(Queue, {
    stables: ["queueName", "storageAccount", "resourceGroup", "queueId"],

    // Queues live inside a storage account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined && news.name !== output.queueName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const name = output?.queueName ?? olds?.name ?? (yield* createStorageChildName(id));
      const observed = yield* getQueue(subscriptionId, resourceGroup, storageAccount, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties?.metadata)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name = news.name ?? output?.queueName ?? (yield* createStorageChildName(id));
      const metadata = {
        ...news.metadata,
        ...(yield* ownershipMetadata(id)),
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        queueName: name,
      };
      const get = getQueue(subscriptionId, resourceGroup, storageAccount, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync metadata against the observed queue.
      if (observed === undefined) {
        yield* storage.CreateQueue({ ...where, properties: { metadata } });
      } else if (tagsDiffer(observed.properties?.metadata, metadata)) {
        yield* storage.UpdateQueue({ ...where, properties: { metadata } });
      }

      const fresh = yield* waitForProvisioned(`queue ${name}`, get, () => undefined, {
        interval: "2 seconds",
        times: 15,
      });
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteQueue({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          queueName: output.queueName,
        }),
      );
      yield* waitUntilGone(
        `queue ${output.queueName}`,
        getQueue(subscriptionId, output.resourceGroup, output.storageAccount, output.queueName),
      );
    }),
  });
