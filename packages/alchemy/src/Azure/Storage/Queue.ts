import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
import {
  createStorageChildName,
  isOwnedByMetadata,
  ownershipMetadata,
  userMetadata,
} from "./StorageOwnership.ts";

export interface QueueProps {
  /** Resource group of the storage account. Changing it replaces the queue. */
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
 * An Azure Storage queue for simple, durable message passing between
 * application components.
 *
 * Queues cannot be tagged, so Alchemy records ownership in queue metadata
 * (`alchemy_stack`, `alchemy_stage`, `alchemy_id`). Deleting the queue
 * deletes every message in it.
 *
 * @see https://learn.microsoft.com/azure/storage/queues/storage-queues-introduction
 *
 * ### Creating a Queue
 * **Example:** Basic queue
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("app", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const jobs = yield* Azure.Storage.Queue("jobs", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * ```
 *
 * **Example:** Queue with metadata
 * ```typescript
 * const jobs = yield* Azure.Storage.Queue("jobs", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   metadata: { purpose: "background_jobs" },
 * });
 * ```
 *
 * @resource
 */
export const Queue = Resource<Queue>("Azure.Storage.Queue");

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
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
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
      const name =
        output?.queueName ?? olds?.name ?? (yield* createStorageChildName(id));
      const observed = yield* getQueue(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties?.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name =
        news.name ?? output?.queueName ?? (yield* createStorageChildName(id));
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

      const fresh = yield* waitForProvisioned(
        `queue ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
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
        getQueue(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.queueName,
        ),
      );
    }),
  });
