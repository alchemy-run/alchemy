import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fromStorageCorsRules,
  storageCorsDiffers,
  toStorageCorsRules,
  type StorageCorsRule,
} from "./StorageCors.ts";
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

export interface QueueServicePropertiesProps {
  /**
   * Resource group of the storage account. Changing it replaces the
   * settings resource.
   */
  resourceGroup: string;
  /**
   * Storage account whose Queue service is configured. Changing it
   * replaces the settings resource.
   */
  storageAccount: string;
  /**
   * CORS rules (at most 5). An empty list removes every rule.
   * @default unmanaged
   */
  cors?: StorageCorsRule[];
}

export interface QueueServiceProperties extends Resource<
  "Azure.Storage.QueueServiceProperties",
  QueueServicePropertiesProps,
  {
    /** Storage account whose Queue service is configured. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the Queue service (`.../queueServices/default`). */
    queueServiceId: string;
    /** Observed CORS rules. */
    cors: StorageCorsRule[];
  },
  never,
  Providers
> {}

/**
 * The Queue service settings of a Storage account
 * (`queueServices/default`): CORS rules for browser clients.
 *
 * This is a singleton: every account has exactly one Queue service. Only
 * the settings you specify are managed. Destroying the resource removes
 * the managed CORS rules.
 *
 * @see https://learn.microsoft.com/rest/api/storageservices/cross-origin-resource-sharing--cors--support-for-the-azure-storage-services
 *
 * ### CORS
 * **Example:** Allow a web app to read and send messages
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("jobs", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Storage.QueueServiceProperties("jobs-queue", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   cors: [
 *     {
 *       allowedOrigins: ["https://app.example.com"],
 *       allowedMethods: ["GET", "POST"],
 *       maxAgeInSeconds: 600,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const QueueServiceProperties = Resource<QueueServiceProperties>(
  "Azure.Storage.QueueServiceProperties",
);

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetQueueServiceServiceProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  observed: storage.GetQueueServiceServicePropertiesResponse,
): QueueServiceProperties["Attributes"] => ({
  storageAccount,
  resourceGroup,
  queueServiceId: observed.id ?? "",
  cors: fromStorageCorsRules(observed.properties?.cors),
});

export const QueueServicePropertiesProvider = () =>
  Provider.succeed(QueueServiceProperties, {
    stables: ["storageAccount", "resourceGroup", "queueServiceId"],

    // A per-account singleton that disappears with its account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const observed = yield* getService(
        subscriptionId,
        resourceGroup,
        storageAccount,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
      };

      // Observe. The Queue service always exists alongside its account.
      const observed = yield* storage.GetQueueServiceServiceProperties(where);
      if (
        news.cors === undefined ||
        !storageCorsDiffers(
          fromStorageCorsRules(observed.properties?.cors),
          news.cors,
        )
      ) {
        return toAttrs(resourceGroup, storageAccount, observed);
      }
      yield* storage.SetQueueServiceServiceProperties({
        ...where,
        properties: { cors: { corsRules: toStorageCorsRules(news.cors) } },
      });
      // The settings propagate to the Queue service asynchronously.
      const cors = news.cors;
      const fresh = yield* storage.GetQueueServiceServiceProperties(where).pipe(
        Effect.repeat({
          until: (current) =>
            !storageCorsDiffers(
              fromStorageCorsRules(current.properties?.cors),
              cors,
            ),
          schedule: Schedule.spaced("2 seconds"),
          times: 30,
        }),
      );
      return toAttrs(resourceGroup, storageAccount, fresh);
    }),

    // Remove the managed CORS rules; a missing account means there is
    // nothing left to reset.
    delete: Effect.fn(function* ({ olds, output }) {
      if (olds?.cors === undefined) return;
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.storageAccount,
      };
      yield* ignoreNotFound(
        storage.SetQueueServiceServiceProperties({
          ...where,
          properties: { cors: { corsRules: [] } },
        }),
      );
      // Wait for the reset to propagate to the Queue service.
      yield* getService(
        where.subscriptionId,
        where.resourceGroupName,
        where.accountName,
      ).pipe(
        Effect.repeat({
          until: (current) =>
            (current?.properties?.cors?.corsRules ?? []).length === 0,
          schedule: Schedule.spaced("2 seconds"),
          times: 30,
        }),
      );
    }),

    nuke: { singleton: true },
  });
