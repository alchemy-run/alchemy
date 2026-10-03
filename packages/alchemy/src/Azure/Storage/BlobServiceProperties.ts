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
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

/** A CORS rule for the Blob service. */
export interface BlobCorsRule {
  /** Origins allowed to make cross-origin requests, or `["*"]`. */
  allowedOrigins: string[];
  /** HTTP methods the origins may use, e.g. `["GET", "PUT"]`. */
  allowedMethods: storage.AllowedMethods[];
  /** Request headers allowed in cross-origin requests. @default ["*"] */
  allowedHeaders?: string[];
  /** Response headers exposed to CORS clients. @default ["*"] */
  exposedHeaders?: string[];
  /** Seconds a browser may cache the preflight response. @default 3600 */
  maxAgeInSeconds?: number;
}

/** A soft-delete retention policy. */
export interface BlobRetentionPolicy {
  /** Whether soft delete is enabled. */
  enabled: boolean;
  /** Days deleted items are retained (1-365). Required when enabled. */
  days?: number;
}

/** Change feed settings. */
export interface BlobChangeFeed {
  /** Whether the change feed is enabled. */
  enabled: boolean;
  /**
   * Days change feed records are kept (1-146000).
   * @default infinite retention
   */
  retentionInDays?: number;
}

/** Point-in-time restore settings. */
export interface BlobRestorePolicy {
  /** Whether point-in-time restore is enabled. */
  enabled: boolean;
  /**
   * Days blobs can be restored; must be less than the blob soft-delete
   * retention days. Required when enabled.
   */
  days?: number;
}

export interface BlobServicePropertiesProps {
  /**
   * Resource group of the storage account. Changing it replaces the
   * settings resource.
   */
  resourceGroup: string;
  /**
   * Storage account whose Blob service is configured. Changing it replaces
   * the settings resource.
   */
  storageAccount: string;
  /**
   * CORS rules (at most 5). An empty list removes every rule.
   * @default unmanaged
   */
  cors?: BlobCorsRule[];
  /**
   * Default REST API version for requests that do not specify one, e.g.
   * `2020-10-02`.
   * @default unmanaged
   */
  defaultServiceVersion?: string;
  /**
   * Blob soft delete.
   * @default unmanaged
   */
  deleteRetentionPolicy?: BlobRetentionPolicy;
  /**
   * Container soft delete.
   * @default unmanaged
   */
  containerDeleteRetentionPolicy?: BlobRetentionPolicy;
  /**
   * Blob versioning.
   * @default unmanaged
   */
  isVersioningEnabled?: boolean;
  /**
   * Blob change feed.
   * @default unmanaged
   */
  changeFeed?: BlobChangeFeed;
  /**
   * Point-in-time restore. Requires versioning, change feed, and blob soft
   * delete.
   * @default unmanaged
   */
  restorePolicy?: BlobRestorePolicy;
  /**
   * Last-access-time tracking, used by lifecycle management rules based on
   * `daysAfterLastAccessTimeGreaterThan`.
   * @default unmanaged
   */
  lastAccessTimeTrackingEnabled?: boolean;
}

export interface BlobServiceProperties extends Resource<
  "Azure.Storage.BlobServiceProperties",
  BlobServicePropertiesProps,
  {
    /** Storage account whose Blob service is configured. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the Blob service (`.../blobServices/default`). */
    blobServiceId: string;
    /** Observed CORS rules. */
    cors: BlobCorsRule[];
    /** Observed blob soft-delete policy. */
    deleteRetentionPolicy: BlobRetentionPolicy;
    /** Observed container soft-delete policy. */
    containerDeleteRetentionPolicy: BlobRetentionPolicy;
    /** Whether blob versioning is enabled. */
    isVersioningEnabled: boolean;
    /** Observed change feed settings. */
    changeFeed: BlobChangeFeed;
    /** Observed point-in-time restore settings. */
    restorePolicy: BlobRestorePolicy;
    /** Whether last-access-time tracking is enabled. */
    lastAccessTimeTrackingEnabled: boolean;
    /** Observed default REST API version. */
    defaultServiceVersion: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The Blob service settings of a Storage account
 * (`blobServices/default`): CORS, soft delete, versioning, change feed,
 * point-in-time restore, and last-access-time tracking.
 *
 * This is a singleton: every account has exactly one Blob service. Only the
 * settings you specify are managed. Destroying the resource resets those
 * settings to Azure's defaults (rules removed, features disabled).
 *
 * @see https://learn.microsoft.com/azure/storage/blobs/soft-delete-blob-overview
 *
 * ### Data Protection
 * **Example:** Versioning with 7-day soft delete
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Storage.BlobServiceProperties("files-blob", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   isVersioningEnabled: true,
 *   deleteRetentionPolicy: { enabled: true, days: 7 },
 *   containerDeleteRetentionPolicy: { enabled: true, days: 7 },
 * });
 * ```
 *
 * **Example:** Point-in-time restore
 * ```typescript
 * yield* Azure.Storage.BlobServiceProperties("files-blob", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   isVersioningEnabled: true,
 *   changeFeed: { enabled: true },
 *   deleteRetentionPolicy: { enabled: true, days: 14 },
 *   restorePolicy: { enabled: true, days: 7 },
 * });
 * ```
 *
 * ### CORS
 * **Example:** Allow browser uploads from one origin
 * ```typescript
 * yield* Azure.Storage.BlobServiceProperties("files-blob", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   cors: [
 *     {
 *       allowedOrigins: ["https://app.example.com"],
 *       allowedMethods: ["GET", "PUT"],
 *       maxAgeInSeconds: 600,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const BlobServiceProperties = Resource<BlobServiceProperties>(
  "Azure.Storage.BlobServiceProperties",
);

type Observed = storage.GetBlobServiceServicePropertiesResponse;

const getService = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetBlobServiceServiceProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

const toCorsRules = (rules: ReadonlyArray<BlobCorsRule>): storage.CorsRule[] =>
  rules.map((rule) => ({
    allowedOrigins: rule.allowedOrigins,
    allowedMethods: rule.allowedMethods,
    allowedHeaders: rule.allowedHeaders ?? ["*"],
    exposedHeaders: rule.exposedHeaders ?? ["*"],
    maxAgeInSeconds: rule.maxAgeInSeconds ?? 3600,
  }));

const retention = (
  policy: storage.DeleteRetentionPolicy | undefined,
): BlobRetentionPolicy => ({
  enabled: policy?.enabled ?? false,
  days: policy?.enabled ? policy.days : undefined,
});

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  observed: Observed,
): BlobServiceProperties["Attributes"] => {
  const props = observed.properties ?? {};
  return {
    storageAccount,
    resourceGroup,
    blobServiceId: observed.id ?? "",
    cors: (props.cors?.corsRules ?? []).map((rule) => ({
      allowedOrigins: [...rule.allowedOrigins],
      allowedMethods: [...rule.allowedMethods] as storage.AllowedMethods[],
      allowedHeaders: [...rule.allowedHeaders],
      exposedHeaders: [...rule.exposedHeaders],
      maxAgeInSeconds: rule.maxAgeInSeconds,
    })),
    deleteRetentionPolicy: retention(props.deleteRetentionPolicy),
    containerDeleteRetentionPolicy: retention(
      props.containerDeleteRetentionPolicy,
    ),
    isVersioningEnabled: props.isVersioningEnabled ?? false,
    changeFeed: {
      enabled: props.changeFeed?.enabled ?? false,
      retentionInDays: props.changeFeed?.enabled
        ? props.changeFeed.retentionInDays
        : undefined,
    },
    restorePolicy: {
      enabled: props.restorePolicy?.enabled ?? false,
      days: props.restorePolicy?.enabled ? props.restorePolicy.days : undefined,
    },
    lastAccessTimeTrackingEnabled:
      props.lastAccessTimeTrackingPolicy?.enable ?? false,
    defaultServiceVersion: props.defaultServiceVersion,
  };
};

const sameRetention = (
  observed: BlobRetentionPolicy,
  desired: BlobRetentionPolicy,
) =>
  observed.enabled === desired.enabled &&
  (!desired.enabled || observed.days === desired.days);

/** CORS rules compare order-sensitively on their canonical JSON. */
const sameCors = (
  observed: ReadonlyArray<BlobCorsRule>,
  desired: ReadonlyArray<BlobCorsRule>,
) =>
  JSON.stringify(toCorsRules(observed)) ===
  JSON.stringify(toCorsRules(desired));

/**
 * The delta between observed and desired settings, covering only the
 * aspects the user manages. Blob service PUT leaves omitted properties
 * unchanged.
 */
const delta = (
  observed: BlobServiceProperties["Attributes"],
  news: BlobServicePropertiesProps,
): storage.BlobServicePropertiesPropertiesInput => {
  const changed: storage.BlobServicePropertiesPropertiesInput = {};
  if (news.cors !== undefined && !sameCors(observed.cors, news.cors)) {
    changed.cors = { corsRules: toCorsRules(news.cors) };
  }
  if (
    news.defaultServiceVersion !== undefined &&
    observed.defaultServiceVersion !== news.defaultServiceVersion
  ) {
    changed.defaultServiceVersion = news.defaultServiceVersion;
  }
  if (
    news.deleteRetentionPolicy !== undefined &&
    !sameRetention(observed.deleteRetentionPolicy, news.deleteRetentionPolicy)
  ) {
    changed.deleteRetentionPolicy = news.deleteRetentionPolicy;
  }
  if (
    news.containerDeleteRetentionPolicy !== undefined &&
    !sameRetention(
      observed.containerDeleteRetentionPolicy,
      news.containerDeleteRetentionPolicy,
    )
  ) {
    changed.containerDeleteRetentionPolicy =
      news.containerDeleteRetentionPolicy;
  }
  if (
    news.isVersioningEnabled !== undefined &&
    observed.isVersioningEnabled !== news.isVersioningEnabled
  ) {
    changed.isVersioningEnabled = news.isVersioningEnabled;
  }
  if (
    news.changeFeed !== undefined &&
    (observed.changeFeed.enabled !== news.changeFeed.enabled ||
      (news.changeFeed.enabled &&
        observed.changeFeed.retentionInDays !==
          news.changeFeed.retentionInDays))
  ) {
    changed.changeFeed = news.changeFeed;
  }
  if (
    news.restorePolicy !== undefined &&
    !sameRetention(observed.restorePolicy, news.restorePolicy)
  ) {
    changed.restorePolicy = news.restorePolicy;
  }
  if (
    news.lastAccessTimeTrackingEnabled !== undefined &&
    observed.lastAccessTimeTrackingEnabled !==
      news.lastAccessTimeTrackingEnabled
  ) {
    changed.lastAccessTimeTrackingPolicy = news.lastAccessTimeTrackingEnabled
      ? {
          enable: true,
          name: "AccessTimeTracking",
          trackingGranularityInDays: 1,
          blobType: ["blockBlob"],
        }
      : { enable: false };
  }
  return changed;
};

/** Azure's defaults for every aspect the user configured. */
const defaultsFor = (
  olds: Partial<BlobServicePropertiesProps>,
): storage.BlobServicePropertiesPropertiesInput => {
  const reset: storage.BlobServicePropertiesPropertiesInput = {};
  if (olds.cors !== undefined) reset.cors = { corsRules: [] };
  // Restore must be disabled before the features it depends on.
  if (olds.restorePolicy !== undefined)
    reset.restorePolicy = { enabled: false };
  if (olds.deleteRetentionPolicy !== undefined) {
    reset.deleteRetentionPolicy = { enabled: false };
  }
  if (olds.containerDeleteRetentionPolicy !== undefined) {
    reset.containerDeleteRetentionPolicy = { enabled: false };
  }
  if (olds.isVersioningEnabled !== undefined) reset.isVersioningEnabled = false;
  if (olds.changeFeed !== undefined) reset.changeFeed = { enabled: false };
  if (olds.lastAccessTimeTrackingEnabled !== undefined) {
    reset.lastAccessTimeTrackingPolicy = { enable: false };
  }
  return reset;
};

export const BlobServicePropertiesProvider = () =>
  Provider.succeed(BlobServiceProperties, {
    stables: ["storageAccount", "resourceGroup", "blobServiceId"],

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

      // Observe. The Blob service always exists alongside its account.
      const observed = yield* storage.GetBlobServiceServiceProperties(where);

      // Sync only the aspects that differ from the observed settings.
      const changed = delta(
        toAttrs(resourceGroup, storageAccount, observed),
        news,
      );
      if (Object.keys(changed).length === 0) {
        return toAttrs(resourceGroup, storageAccount, observed);
      }
      yield* storage.SetBlobServiceServiceProperties({
        ...where,
        properties: changed,
      });
      const fresh = yield* storage.GetBlobServiceServiceProperties(where);
      return toAttrs(resourceGroup, storageAccount, fresh);
    }),

    // Reset the managed settings to Azure's defaults; a missing account
    // means there is nothing left to reset.
    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const reset = defaultsFor(olds ?? {});
      if (Object.keys(reset).length === 0) return;
      yield* ignoreNotFound(
        storage.SetBlobServiceServiceProperties({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          properties: reset,
        }),
      );
    }),

    nuke: { singleton: true },
  });
