import * as purview from "@distilled.cloud/azure/purview";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createAccountName, getAccount, type ObservedAccount, sameName } from "./internal.ts";

export type PurviewNetworkAccess = "Enabled" | "Disabled";

export interface AccountIdentity {
  /**
   * `SystemAssigned` gives the account its own identity; `UserAssigned`
   * uses the identities listed in `userAssignedIdentities`. Purview scans
   * data sources with this identity.
   */
  type: "SystemAssigned" | "UserAssigned";
  /** ARM IDs of user-assigned identities (with `type: "UserAssigned"`). */
  userAssignedIdentities?: string[];
}

export interface AccountProps {
  /**
   * Resource group the account is created in. Changing it replaces the
   * account.
   */
  resourceGroup: string;
  /**
   * Globally unique account name (`<name>.purview.azure.com`): 3-63
   * letters, digits, and hyphens, starting and ending with a letter or
   * digit. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account and its metadata. The first account of a
   * tenant must be in the location that matches the tenant's Microsoft
   * Entra home region. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Name of the resource group Purview creates for its managed resources
   * (a storage account and, if enabled, an Event Hubs namespace). It must
   * not exist yet. Changing it replaces the account.
   * @default Azure generates `managed-rg-<random>`
   */
  managedResourceGroupName?: string;
  /**
   * Managed identity of the account.
   * @default { type: "SystemAssigned" }
   */
  identity?: AccountIdentity;
  /**
   * Whether the account's public endpoints accept traffic. Set `Disabled`
   * when the account is reached only through private endpoints.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: PurviewNetworkAccess;
  /**
   * Whether the managed storage account and Event Hubs namespace accept
   * public traffic.
   * @default Azure's default (`Enabled`)
   */
  managedResourcesPublicNetworkAccess?: PurviewNetworkAccess;
  /**
   * Whether Purview creates a managed Event Hubs namespace for Atlas Kafka
   * notifications. Disable it when a `KafkaConfiguration` points the
   * account at your own event hubs.
   * @default Azure's default
   */
  managedEventHubState?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.Purview.Account",
  AccountProps,
  {
    /** Name of the account. */
    accountName: string;
    /** ARM resource ID of the account; use it as a role-assignment scope. */
    accountId: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account. */
    location: string;
    /** Name of the resource group that holds Purview's managed resources. */
    managedResourceGroupName: string | undefined;
    /** ARM ID of the managed storage account. */
    managedStorageAccountId: string | undefined;
    /** ARM ID of the managed Event Hubs namespace, if enabled. */
    managedEventHubNamespaceId: string | undefined;
    /** Data catalog endpoint, e.g. `https://<name>.purview.azure.com/catalog`. */
    catalogEndpoint: string | undefined;
    /** Scan endpoint, e.g. `https://<name>.purview.azure.com/scan`. */
    scanEndpoint: string | undefined;
    /** Guardian endpoint. */
    guardianEndpoint: string | undefined;
    /** Identity type of the account. */
    identityType: string | undefined;
    /**
     * Object ID of the account's system-assigned identity. Grant it read
     * access (for example `Storage Blob Data Reader`) on the sources it
     * scans.
     */
    principalId: string | undefined;
    /** Microsoft Entra tenant of the account's identity. */
    tenantId: string | undefined;
    /** Whether the public endpoints accept traffic. */
    publicNetworkAccess: string | undefined;
    /** Whether the managed resources accept public traffic. */
    managedResourcesPublicNetworkAccess: string | undefined;
    /** State of the managed Event Hubs namespace. */
    managedEventHubState: string | undefined;
    /** Pricing tier (always `Standard`). */
    sku: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Purview account (`Microsoft.Purview/accounts`) — the Purview
 * Data Map: it catalogs, classifies, and traces lineage for data across
 * Azure, on-premises, and other clouds. Purview creates a managed resource
 * group with a storage account (and optionally an Event Hubs namespace)
 * next to the account.
 *
 * A tenant can create only one Purview account: Azure reconciles the first
 * one into the tenant-level account of the Microsoft Purview portal. The
 * Data Map is billed per capacity unit hour. Provisioning takes about 5-15
 * minutes.
 *
 * @see https://learn.microsoft.com/purview/legacy/create-microsoft-purview-portal
 *
 * ### Creating an Account
 * **Example:** Purview account with a system-assigned identity
 * ```typescript
 * const catalog = yield* Azure.Purview.Account("catalog", {
 *   location: "eastus",
 * });
 * ```
 *
 * **Example:** Named managed resource group, tagged
 * ```typescript
 * const catalog = yield* Azure.Purview.Account("catalog", {
 *   location: "eastus",
 *   managedResourceGroupName: "catalog-managed",
 *   tags: { team: "data" },
 * });
 * ```
 *
 * ### Scanning a Storage Account
 * **Example:** Let the account read the blobs it scans
 * ```typescript
 * const catalog = yield* Azure.Purview.Account("catalog");
 * const lake = yield* Azure.Storage.StorageAccount("lake");
 * yield* Azure.Authorization.RoleAssignment("catalog-reads-lake", {
 *   scope: lake.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: catalog.principalId.as<string>(),
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * ### Private Access
 * **Example:** Close the public endpoints
 * ```typescript
 * const catalog = yield* Azure.Purview.Account("catalog", {
 *   publicNetworkAccess: "Disabled",
 *   managedResourcesPublicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * :::caution
 * Changing `name`, `location`, `resourceGroup`, or
 * `managedResourceGroupName` replaces the account and deletes its Data Map
 * (every scanned asset, classification, and lineage record).
 * :::
 *
 * @resource
 */
export const Account = GroupedResource<Account>("Azure.Purview.Account");

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedAccount,
): Account["Attributes"] => {
  const props = observed.properties ?? {};
  return {
    accountName: name,
    accountId: observed.id ?? "",
    resourceGroup,
    location: observed.location ?? "",
    managedResourceGroupName: props.managedResourceGroupName,
    managedStorageAccountId: props.managedResources?.storageAccount,
    managedEventHubNamespaceId: props.managedResources?.eventHubNamespace,
    catalogEndpoint: props.endpoints?.catalog,
    scanEndpoint: props.endpoints?.scan,
    guardianEndpoint: props.endpoints?.guardian,
    identityType: observed.identity?.type,
    principalId: observed.identity?.principalId,
    tenantId: observed.identity?.tenantId,
    publicNetworkAccess: props.publicNetworkAccess,
    managedResourcesPublicNetworkAccess: props.managedResourcesPublicNetworkAccess,
    managedEventHubState: props.managedEventHubState,
    sku: observed.sku?.name ?? "Standard",
    tags: userTags(observed.tags),
  };
};

const toIdentity = (identity: AccountIdentity): purview.IdentityInput => ({
  type: identity.type,
  userAssignedIdentities:
    identity.type === "UserAssigned" && identity.userAssignedIdentities?.length
      ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
      : undefined,
});

const identityDiffers = (observed: ObservedAccount["identity"], desired: AccountIdentity) => {
  if ((observed?.type ?? "None").toLowerCase() !== desired.type.toLowerCase()) return true;
  if (desired.type !== "UserAssigned") return false;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? []).map((id) => id.toLowerCase()).sort();
  return have.join(",") !== want.join(",");
};

/** A setting the user left unset is owned by Azure and never compared. */
const settingDiffers = (observed: string | undefined, desired: string | undefined) =>
  desired !== undefined && observed?.toLowerCase() !== desired.toLowerCase();

const normalizeLocation = (location: string | undefined) =>
  location?.toLowerCase().replace(/\s/g, "");

/**
 * ARM rejects a write while a previous operation on the account is still
 * running (`Conflict`); short waits converge.
 */
const whileBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("15 seconds"),
  times: 10,
} as const;

/** Creating an account provisions a managed storage account: minutes. */
const PROVISION_BUDGET = { interval: "15 seconds", times: 80 } as const;

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["accountName", "accountId", "resourceGroup", "location", "managedResourceGroupName"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const accounts = yield* purview.ListAccountBySubscription.items({ subscriptionId }).pipe(
        Stream.runCollect,
      );
      return Array.from(accounts).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) &&
          group !== undefined &&
          account.name !== undefined &&
          account.properties?.provisioningState !== "SoftDeleted"
          ? [toAttrs(group, account.name, account)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.accountName)) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !== normalizeLocation(output.location)) ||
        (news.managedResourceGroupName !== undefined &&
          !sameName(news.managedResourceGroupName, output.managedResourceGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name = output?.accountName ?? olds?.name ?? (yield* createAccountName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      const owned = yield* isOwned(id, observed.tags);
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      // Purview provisions a managed storage account and Event Hubs
      // namespace in the subscription.
      yield* ensureRegistered(subscriptionId, "Microsoft.Purview");
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      yield* ensureRegistered(subscriptionId, "Microsoft.EventHub");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.accountName ?? (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity: AccountIdentity = news.identity ?? { type: "SystemAssigned" };
      const where = { subscriptionId, resourceGroupName: resourceGroup, accountName: name };
      const get = getAccount(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `purview account ${name}`,
        get,
        (account) => account.properties?.provisioningState,
        PROVISION_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* purview
          .AccountsCreateOrUpdate({
            ...where,
            location,
            tags,
            identity: toIdentity(identity),
            properties: {
              managedResourceGroupName: news.managedResourceGroupName,
              publicNetworkAccess: news.publicNetworkAccess,
              managedResourcesPublicNetworkAccess: news.managedResourcesPublicNetworkAccess,
              managedEventHubState: news.managedEventHubState,
            },
          })
          .pipe(Effect.retry(whileBusy));
      }
      observed = yield* waitReady;

      // Sync identity, network access, the managed event hub, and tags
      // against the observed account. One PATCH carries the delta.
      const props = observed.properties ?? {};
      const properties: purview.AccountPropertiesInput = {};
      if (settingDiffers(props.publicNetworkAccess, news.publicNetworkAccess)) {
        properties.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        settingDiffers(
          props.managedResourcesPublicNetworkAccess,
          news.managedResourcesPublicNetworkAccess,
        )
      ) {
        properties.managedResourcesPublicNetworkAccess = news.managedResourcesPublicNetworkAccess;
      }
      if (settingDiffers(props.managedEventHubState, news.managedEventHubState)) {
        properties.managedEventHubState = news.managedEventHubState;
      }
      const patch: purview.UpdateAccountRequest = { ...where };
      let changed = false;
      if (identityDiffers(observed.identity, identity)) {
        patch.identity = toIdentity(identity);
        changed = true;
      }
      if (Object.keys(properties).length > 0) {
        patch.properties = properties;
        changed = true;
      }
      if (tagsDiffer(observed.tags, tags)) {
        patch.tags = tags;
        changed = true;
      }
      if (changed) {
        yield* purview.UpdateAccount(patch).pipe(Effect.retry(whileBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        purview
          .DeleteAccount({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.accountName,
          })
          .pipe(Effect.retry(whileBusy)),
      );
      // Deleting the account also deletes its managed resource group.
      yield* waitUntilGone(
        `purview account ${output.accountName}`,
        getAccount(subscriptionId, output.resourceGroup, output.accountName),
        { interval: "15 seconds", times: 80 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
