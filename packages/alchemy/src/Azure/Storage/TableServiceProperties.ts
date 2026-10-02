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

export interface TableServicePropertiesProps {
  /**
   * Resource group of the storage account. Changing it replaces the
   * settings resource.
   */
  resourceGroup: string;
  /**
   * Storage account whose Table service is configured. Changing it
   * replaces the settings resource.
   */
  storageAccount: string;
  /**
   * CORS rules (at most 5). An empty list removes every rule.
   * @default unmanaged
   */
  cors?: StorageCorsRule[];
}

export interface TableServiceProperties extends Resource<
  "Azure.Storage.TableServiceProperties",
  TableServicePropertiesProps,
  {
    /** Storage account whose Table service is configured. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the Table service (`.../tableServices/default`). */
    tableServiceId: string;
    /** Observed CORS rules. */
    cors: StorageCorsRule[];
  },
  never,
  Providers
> {}

/**
 * The Table service settings of a Storage account
 * (`tableServices/default`): CORS rules for browser clients.
 *
 * This is a singleton: every account has exactly one Table service. Only
 * the settings you specify are managed. Destroying the resource removes
 * the managed CORS rules.
 *
 * @see https://learn.microsoft.com/rest/api/storageservices/cross-origin-resource-sharing--cors--support-for-the-azure-storage-services
 *
 * ### CORS
 * **Example:** Allow a web app to query entities
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("catalog", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Storage.TableServiceProperties("catalog-table", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   cors: [
 *     {
 *       allowedOrigins: ["https://app.example.com"],
 *       allowedMethods: ["GET", "OPTIONS"],
 *       maxAgeInSeconds: 600,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const TableServiceProperties = Resource<TableServiceProperties>(
  "Azure.Storage.TableServiceProperties",
);

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetTableServiceServiceProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  observed: storage.GetTableServiceServicePropertiesResponse,
): TableServiceProperties["Attributes"] => ({
  storageAccount,
  resourceGroup,
  tableServiceId: observed.id ?? "",
  cors: fromStorageCorsRules(observed.properties?.cors),
});

export const TableServicePropertiesProvider = () =>
  Provider.succeed(TableServiceProperties, {
    stables: ["storageAccount", "resourceGroup", "tableServiceId"],

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

      // Observe. The Table service always exists alongside its account.
      const observed = yield* storage.GetTableServiceServiceProperties(where);
      if (
        news.cors === undefined ||
        !storageCorsDiffers(
          fromStorageCorsRules(observed.properties?.cors),
          news.cors,
        )
      ) {
        return toAttrs(resourceGroup, storageAccount, observed);
      }
      yield* storage.SetTableServiceServiceProperties({
        ...where,
        properties: { cors: { corsRules: toStorageCorsRules(news.cors) } },
      });
      const fresh = yield* storage.GetTableServiceServiceProperties(where);
      return toAttrs(resourceGroup, storageAccount, fresh);
    }),

    // Remove the managed CORS rules; a missing account means there is
    // nothing left to reset.
    delete: Effect.fn(function* ({ olds, output }) {
      if (olds?.cors === undefined) return;
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.SetTableServiceServiceProperties({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          properties: { cors: { corsRules: [] } },
        }),
      );
    }),

    nuke: { singleton: true },
  });
