import * as storage from "@distilled.cloud/azure/storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createStorageChildName } from "./StorageOwnership.ts";

/** A managed identity that may read the shared assets. */
export interface DataShareAccessPolicy {
  /** Entra principal ID of the managed identity. */
  principalId: string;
  /** Entra tenant ID of the managed identity. */
  tenantId: string;
  /**
   * Permission granted to the identity. Only `Read` grants access.
   * @default "Read"
   */
  permission?: "None" | "Read";
}

/** A folder or blob exposed through the data share. */
export interface DataShareAsset {
  /**
   * Path to share: the container name followed by a path inside it,
   * e.g. `/container1/logs/external`.
   */
  assetPath: string;
  /** Name the consumer sees for the shared path. */
  displayName: string;
}

export interface DataShareProps {
  /** Resource group of the storage account. Changing it replaces the data share. */
  resourceGroup: string;
  /** Storage account that holds the shared data. Changing it replaces the data share. */
  storageAccount: string;
  /**
   * Data share name (3-63 lowercase letters, digits, and single hyphens).
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the data share.
   */
  name?: string;
  /**
   * Azure region; must match the storage account's region. Changing it
   * replaces the data share.
   * @default the provider's default location
   */
  location?: string;
  /** Description of the data share (max 250 characters). */
  description?: string;
  /**
   * Managed identities allowed to read the shared assets. The list replaces
   * the share's access policies on every update.
   * @default []
   */
  accessPolicies?: DataShareAccessPolicy[];
  /**
   * Folders and blobs exposed through the share. The list replaces the
   * share's assets on every update.
   * @default []
   */
  assets?: DataShareAsset[];
  /** Resource tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface DataShare extends Resource<
  "Azure.Storage.DataShare",
  DataShareProps,
  {
    /** Name of the data share. */
    dataShareName: string;
    /** Storage account that holds the shared data. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the data share. */
    dataShareId: string;
    /** Azure region of the data share. */
    location: string;
    /** System-generated GUID of the data share. */
    dataShareIdentifier: string | undefined;
    /**
     * URI to give the consumer, `azds://<location>:<name>:<identifier>`.
     * A `Azure.Storage.Connector` in the consumer's account reads it.
     */
    dataShareUri: string | undefined;
    /** Description of the data share. */
    description: string | undefined;
    /** Managed identities allowed to read the shared assets. */
    accessPolicies: Required<DataShareAccessPolicy>[];
    /** Folders and blobs exposed through the share. */
    assets: DataShareAsset[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Storage data share (`Microsoft.Storage/storageAccounts/dataShares`):
 * exposes folders and blobs of this storage account, read-only, to managed
 * identities in another account or tenant. The consumer reads the share
 * through an `Azure.Storage.Connector` pointed at `dataShareUri`.
 *
 * Storage data shares are a preview feature that needs subscription
 * enrollment (`Microsoft.Storage/StorageDataShare`) and an account with
 * `dataCollaborationPolicy.allowStorageDataShares` set to `true`.
 *
 * :::caution
 * Changing `storageAccount`, `resourceGroup`, `name`, or `location`
 * replaces the data share and changes its `dataShareUri`.
 * :::
 *
 * ### Sharing Data
 * **Example:** Share a folder with a managed identity
 * ```typescript
 * const container = yield* Azure.Storage.BlobContainer("logs", {
 *   storageAccount: account.storageAccountName,
 * });
 * const reader = yield* Azure.ManagedIdentity.UserAssignedIdentity("reader");
 * const share = yield* Azure.Storage.DataShare("partner-logs", {
 *   storageAccount: account.storageAccountName,
 *   description: "Logs for our partner",
 *   assets: [{ assetPath: `/${container.containerName}/external`, displayName: "logs" }],
 *   accessPolicies: [
 *     { principalId: reader.principalId, tenantId: reader.tenantId, permission: "Read" },
 *   ],
 * });
 * // hand share.dataShareUri to the consumer
 * ```
 *
 * @resource
 */
export const DataShare = GroupedResource<DataShare>("Azure.Storage.DataShare");

const getDataShare = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  dataShareName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetDataShare({
      subscriptionId,
      resourceGroupName,
      accountName,
      dataShareName,
    }),
  );

const normalizeLocation = (location: string) => location.toLowerCase().replace(/\s/g, "");

const desiredPolicies = (policies: DataShareAccessPolicy[] | undefined) =>
  (policies ?? []).map((p) => ({
    principalId: p.principalId,
    tenantId: p.tenantId,
    permission: p.permission ?? "Read",
  }));

const policyKey = (p: { principalId: string; tenantId: string; permission: string }) =>
  `${p.principalId.toLowerCase()}|${p.tenantId.toLowerCase()}|${p.permission}`;

const assetKey = (a: DataShareAsset) => `${a.assetPath}|${a.displayName}`;

const sameSet = <T>(a: readonly T[], b: readonly T[], key: (t: T) => string) => {
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
};

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  observed: storage.GetDataShareResponse,
): DataShare["Attributes"] => ({
  dataShareName: name,
  storageAccount,
  resourceGroup,
  dataShareId: observed.id ?? "",
  location: observed.location,
  dataShareIdentifier: observed.properties.dataShareIdentifier,
  dataShareUri: observed.properties.dataShareUri,
  description: observed.properties.description,
  accessPolicies: (observed.properties.accessPolicies ?? []).map((p) => ({
    principalId: p.principalId,
    tenantId: p.tenantId,
    permission: p.permission === "None" ? "None" : "Read",
  })),
  assets: (observed.properties.assets ?? []).map((a) => ({
    assetPath: a.assetPath,
    displayName: a.displayName,
  })),
  tags: userTags(observed.tags),
});

export const DataShareProvider = () =>
  Provider.succeed(DataShare, {
    stables: ["dataShareName", "storageAccount", "resourceGroup", "dataShareId", "location"],

    // Data shares disappear with their storage account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined && news.name !== output.dataShareName) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !== normalizeLocation(output.location))
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
      const name = output?.dataShareName ?? olds?.name ?? (yield* createStorageChildName(id));
      const observed = yield* getDataShare(subscriptionId, resourceGroup, storageAccount, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return isOwned(id, observed.tags) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name = news.name ?? output?.dataShareName ?? (yield* createStorageChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const accessPolicies = desiredPolicies(news.accessPolicies);
      const assets = (news.assets ?? []).map((a) => ({
        assetPath: a.assetPath,
        displayName: a.displayName,
      }));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        dataShareName: name,
      };
      const get = getDataShare(subscriptionId, resourceGroup, storageAccount, name);

      // Observe.
      const observed = yield* get;

      // Ensure. Create errors out when the share exists, so it only runs
      // when observation found nothing.
      if (observed === undefined) {
        yield* storage.CreateDataShare({
          ...where,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: {
            description: news.description,
            accessPolicies,
            assets,
          },
        });
      } else {
        // Sync: PATCH replaces the policy and asset lists wholesale, so send
        // only the aspects that drifted from the observed share.
        const p = observed.properties;
        const policiesDrift = !sameSet(
          (p.accessPolicies ?? []).map((x) => ({
            principalId: x.principalId,
            tenantId: x.tenantId,
            permission: x.permission,
          })),
          accessPolicies,
          policyKey,
        );
        const assetsDrift = !sameSet(p.assets ?? [], assets, assetKey);
        const descriptionDrift =
          news.description !== undefined && p.description !== news.description;
        if (policiesDrift || assetsDrift || descriptionDrift || tagsDiffer(observed.tags, tags)) {
          yield* storage.UpdateDataShare({
            ...where,
            tags,
            properties: {
              description: descriptionDrift ? news.description : undefined,
              accessPolicies: policiesDrift ? accessPolicies : undefined,
              assets: assetsDrift ? assets : undefined,
            },
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `storage data share ${name}`,
        get,
        (value) => value.properties.provisioningState,
      );
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteDataShare({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          dataShareName: output.dataShareName,
        }),
      );
      yield* waitUntilGone(
        `storage data share ${output.dataShareName}`,
        getDataShare(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.dataShareName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Storage.StorageAccount", "Azure.Resources.ResourceGroup"],
    },
  });
