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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

/** Which blobs or containers an inventory rule reports on. */
export interface InventoryRuleFilters {
  /** Blob name prefixes to include, e.g. `["container/logs/"]`. */
  prefixMatch?: string[];
  /** Blob name prefixes to exclude. */
  excludePrefix?: string[];
  /**
   * Blob types to include: `blockBlob`, `appendBlob`, `pageBlob`. Required
   * for `Blob` rules.
   */
  blobTypes?: string[];
  /** Include blob versions (requires versioning). */
  includeBlobVersions?: boolean;
  /** Include blob snapshots. */
  includeSnapshots?: boolean;
  /** Include soft-deleted blobs. */
  includeDeleted?: boolean;
  /** Only include blobs created in the last N days. */
  creationTimeLastNDays?: number;
}

/** A blob inventory rule. */
export interface InventoryRule {
  /** Rule name, unique within the policy. */
  name: string;
  /**
   * Whether the rule runs.
   * @default true
   */
  enabled?: boolean;
  /** Container the inventory reports are written to. */
  destination: string;
  /** Report format. @default "Csv" */
  format?: storage.Format;
  /** How often reports are generated. @default "Daily" */
  schedule?: storage.Schedule;
  /** Whether the report lists blobs or containers. @default "Blob" */
  objectType?: storage.ObjectType;
  /**
   * Report columns, e.g. `["Name", "Creation-Time", "Content-Length"]`.
   * `Name` is mandatory.
   */
  schemaFields: string[];
  /** Blobs or containers the rule covers. */
  filters?: InventoryRuleFilters;
}

export interface BlobInventoryPolicyProps {
  /**
   * Resource group of the storage account. Changing it replaces the policy.
   */
  resourceGroup: string;
  /** Storage account the policy applies to. Changing it replaces the policy. */
  storageAccount: string;
  /**
   * Whether the policy runs.
   * @default true
   */
  enabled?: boolean;
  /** Inventory rules (at most 100). */
  rules: InventoryRule[];
}

export interface BlobInventoryPolicy extends Resource<
  "Azure.Storage.BlobInventoryPolicy",
  BlobInventoryPolicyProps,
  {
    /** Storage account the policy applies to. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the policy (`.../inventoryPolicies/default`). */
    inventoryPolicyId: string;
    /** Whether the policy is enabled. */
    enabled: boolean;
    /** Names of the rules in the policy. */
    ruleNames: string[];
    /** When the policy was last modified. */
    lastModifiedTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The blob inventory policy of a Storage account: scheduled CSV or Parquet
 * reports listing blobs or containers and their properties, written to a
 * container in the same account.
 *
 * Each account has at most one policy (always named `default`); the policy
 * replaces its whole rule set on every change. Destroying the resource
 * deletes the policy (reports already written are kept).
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/blob-inventory
 *
 * ### Inventory Reports
 * **Example:** Daily CSV report of block blobs
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("data", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const reports = yield* Azure.Storage.BlobContainer("reports", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * yield* Azure.Storage.BlobInventoryPolicy("inventory", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   rules: [
 *     {
 *       name: "allBlobs",
 *       destination: reports.containerName,
 *       schemaFields: ["Name", "Creation-Time", "Last-Modified", "Content-Length"],
 *       filters: { blobTypes: ["blockBlob"] },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Weekly Parquet report of containers
 * ```typescript
 * yield* Azure.Storage.BlobInventoryPolicy("inventory", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   rules: [
 *     {
 *       name: "containers",
 *       destination: reports.containerName,
 *       objectType: "Container",
 *       format: "Parquet",
 *       schedule: "Weekly",
 *       schemaFields: ["Name", "Last-Modified", "Metadata"],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const BlobInventoryPolicy = Resource<BlobInventoryPolicy>(
  "Azure.Storage.BlobInventoryPolicy",
);

const POLICY_NAME = "default";

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetBlobInventoryPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      blobInventoryPolicyName: POLICY_NAME,
    }),
  );

const toFilters = (
  filters: InventoryRuleFilters | undefined,
): storage.BlobInventoryPolicyFilter | undefined => {
  if (filters === undefined) return undefined;
  const { creationTimeLastNDays, ...rest } = filters;
  return {
    ...rest,
    creationTime:
      creationTimeLastNDays === undefined
        ? undefined
        : { lastNDays: creationTimeLastNDays },
  };
};

const toRules = (
  rules: ReadonlyArray<InventoryRule>,
): storage.BlobInventoryPolicyRule[] =>
  rules.map((rule) => ({
    name: rule.name,
    enabled: rule.enabled ?? true,
    destination: rule.destination,
    definition: {
      format: rule.format ?? "Csv",
      schedule: rule.schedule ?? "Daily",
      objectType: rule.objectType ?? "Blob",
      schemaFields: rule.schemaFields,
      filters: toFilters(rule.filters),
    },
  }));

/**
 * Sorted-key JSON with `undefined` members dropped and string arrays
 * sorted, for comparison (Azure may reorder filter lists and fields).
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) => {
    if (Array.isArray(inner)) {
      return inner.every((item) => typeof item === "string")
        ? [...inner].sort()
        : inner;
    }
    return inner !== null && typeof inner === "object"
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)),
        )
      : inner;
  });

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  policy: storage.GetBlobInventoryPolicyResponse,
): BlobInventoryPolicy["Attributes"] => ({
  storageAccount,
  resourceGroup,
  inventoryPolicyId: policy.id ?? "",
  enabled: policy.properties?.policy.enabled ?? false,
  ruleNames: (policy.properties?.policy.rules ?? []).map((rule) => rule.name),
  lastModifiedTime: policy.properties?.lastModifiedTime,
});

export const BlobInventoryPolicyProvider = () =>
  Provider.succeed(BlobInventoryPolicy, {
    stables: ["storageAccount", "resourceGroup", "inventoryPolicyId"],

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
      const observed = yield* getPolicy(
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
      const enabled = news.enabled ?? true;
      const rules = toRules(news.rules);
      const get = getPolicy(subscriptionId, resourceGroup, storageAccount);

      // Observe; the PUT is a full upsert, so only send it on a delta.
      const observed = yield* get;
      if (
        observed === undefined ||
        observed.properties?.policy.enabled !== enabled ||
        canonical(observed.properties?.policy.rules ?? []) !== canonical(rules)
      ) {
        yield* storage.BlobInventoryPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: storageAccount,
          blobInventoryPolicyName: POLICY_NAME,
          properties: { policy: { enabled, type: "Inventory", rules } },
        });
      }

      const fresh = yield* waitForProvisioned(
        `inventory policy of ${storageAccount}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, storageAccount, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteBlobInventoryPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          blobInventoryPolicyName: POLICY_NAME,
        }),
      );
      yield* waitUntilGone(
        `inventory policy of ${output.storageAccount}`,
        getPolicy(subscriptionId, output.resourceGroup, output.storageAccount),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Storage.StorageAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
