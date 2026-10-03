import * as maps from "@distilled.cloud/azure/maps";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** SKU of a Maps account. `S0`/`S1` are Gen1 SKUs (retired). */
export type MapsSkuName = "G2" | "S0" | "S1";

/** Generation of a Maps account. `Gen1` is retired. */
export type MapsAccountKind = "Gen2" | "Gen1";

/** Managed identity type of a Maps account. */
export type MapsIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

export interface MapsAccountIdentity {
  /** Which identities to attach to the account. */
  type: MapsIdentityType;
  /**
   * ARM resource IDs of user-assigned identities to attach. Required when
   * `type` includes `UserAssigned` (also needed for SAS tokens).
   */
  userAssignedIdentities?: string[];
}

export interface MapsCorsRule {
  /** Origins allowed to call the account, or `"*"` for all origins. */
  allowedOrigins: string[];
}

export interface MapsLinkedResource {
  /** Name that identifies the linked resource in Maps REST calls. */
  uniqueName: string;
  /** ARM resource ID of the linked resource (e.g. a storage account). */
  id: string;
}

export interface MapsCustomerManagedKeyEncryption {
  /**
   * Key Vault key URL (versioned or not), e.g.
   * `https://vault.vault.azure.net/keys/kek`.
   */
  keyEncryptionKeyUrl?: string;
  /** Identity used to reach the key. */
  keyEncryptionKeyIdentity?: {
    /** `systemAssignedIdentity` or `userAssignedIdentity`. */
    identityType?: "systemAssignedIdentity" | "userAssignedIdentity";
    /** ARM ID of the user-assigned identity (for `userAssignedIdentity`). */
    userAssignedIdentityResourceId?: string;
  };
}

export interface AccountProps {
  /**
   * Resource group the account is created in. Changing it replaces the
   * account.
   */
  resourceGroup: string;
  /**
   * Name of the account, 1-98 characters of letters, digits, `-`, `_` and
   * `.`, starting with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * account.
   */
  name?: string;
  /**
   * Azure location of the account. Maps accounts are only offered in some
   * regions (e.g. `eastus`, `westus2`, `westcentralus`, `westeurope`,
   * `northeurope`, `uksouth`). Changing it replaces the account.
   * @default the environment location when Maps supports it, else `eastus`
   */
  location?: string;
  /**
   * Pricing SKU. Can be changed in place.
   * @default "G2"
   */
  sku?: MapsSkuName;
  /**
   * Account generation. Upgrading `Gen1` → `Gen2` is in place; any other
   * change replaces the account.
   * @default "Gen2"
   */
  kind?: MapsAccountKind;
  /**
   * Managed identities attached to the account.
   * @default no identity
   */
  identity?: MapsAccountIdentity;
  /**
   * Disable shared-key and SAS authentication, forcing Microsoft Entra ID.
   * When `true`, `primaryKey`/`secondaryKey` are not returned.
   * @default false
   */
  disableLocalAuth?: boolean;
  /**
   * CORS rules for browser access (up to five). An empty or omitted list
   * disables CORS.
   */
  cors?: MapsCorsRule[];
  /**
   * Resources linked to the account (e.g. a storage account for the data
   * registry). The list is replaced as a whole.
   */
  linkedResources?: MapsLinkedResource[];
  /**
   * Enable infrastructure (double) encryption. Changing it replaces the
   * account.
   */
  infrastructureEncryption?: boolean;
  /**
   * Customer-managed key encryption. Only managed when set.
   */
  customerManagedKeyEncryption?: MapsCustomerManagedKeyEncryption;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.Maps.Account",
  AccountProps,
  {
    /** Name of the account. */
    accountName: string;
    /** ARM resource ID of the account. */
    accountId: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account. */
    location: string;
    /**
     * Unique ID of the account; send it as the `x-ms-client-id` header when
     * calling Maps REST APIs with Microsoft Entra ID.
     */
    uniqueId: string;
    /** SKU of the account. */
    sku: string;
    /** Generation of the account. */
    kind: string;
    /** Whether shared-key/SAS authentication is disabled. */
    disableLocalAuth: boolean;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Primary shared key; undefined when local auth is disabled. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary shared key; undefined when local auth is disabled. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Maps account — the entry point for Maps REST APIs and SDKs
 * (rendering, search, routing, geolocation, weather). Gen2 accounts are
 * billed per transaction with a free monthly allowance and no hourly fee.
 *
 * @see https://learn.microsoft.com/azure/azure-maps/how-to-manage-account-keys
 *
 * ### Creating an Account
 * **Example:** Gen2 Maps account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const account = yield* Azure.Maps.Account("maps", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Browser Access
 * **Example:** Allow a web origin via CORS
 * ```typescript
 * const account = yield* Azure.Maps.Account("maps", {
 *   resourceGroup: group.resourceGroupName,
 *   cors: [{ allowedOrigins: ["https://example.com"] }],
 * });
 * ```
 *
 * ### Microsoft Entra ID Only
 * **Example:** Disable shared keys and attach a system identity
 * ```typescript
 * const account = yield* Azure.Maps.Account("maps", {
 *   resourceGroup: group.resourceGroupName,
 *   disableLocalAuth: true,
 *   identity: { type: "SystemAssigned" },
 * });
 * // Send account.uniqueId as the x-ms-client-id header.
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Azure.Maps.Account");

const SUPPORTED_LOCATIONS = new Set([
  "eastus",
  "westus2",
  "westcentralus",
  "westeurope",
  "northeurope",
  "uksouth",
  "francecentral",
  "swedencentral",
  "switzerlandnorth",
  "australiaeast",
  "koreacentral",
  "japaneast",
]);

type ObservedAccount = maps.GetAccountResponse | maps.MapsAccount;

const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    maps.GetAccount({ subscriptionId, resourceGroupName, accountName }),
  );

const normLocation = (value: string | undefined) =>
  value?.toLowerCase().replace(/\s/g, "");

const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 98 });

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  disableLocalAuth: boolean,
) =>
  disableLocalAuth
    ? Effect.succeed({ primary: undefined, secondary: undefined })
    : maps
        .ListAccountKeys({ subscriptionId, resourceGroupName, accountName })
        .pipe(
          Effect.map((keys) => ({
            primary:
              keys.primaryKey === undefined
                ? undefined
                : Redacted.make(keys.primaryKey),
            secondary:
              keys.secondaryKey === undefined
                ? undefined
                : Redacted.make(keys.secondaryKey),
          })),
        );

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
  keys: {
    primary: Redacted.Redacted<string> | undefined;
    secondary: Redacted.Redacted<string> | undefined;
  },
): Account["Attributes"] => ({
  accountName: name,
  accountId: account.id ?? "",
  resourceGroup,
  location: account.location,
  uniqueId: account.properties?.uniqueId ?? "",
  sku: account.sku?.name ?? "",
  kind: account.kind ?? "",
  disableLocalAuth: account.properties?.disableLocalAuth ?? false,
  principalId: account.identity?.principalId,
  primaryKey: keys.primary,
  secondaryKey: keys.secondary,
  provisioningState: account.properties?.provisioningState,
  tags: userTags(account.tags),
});

// --- desired-vs-observed normalization -------------------------------------

const identityKey = (
  type: string | undefined,
  ids: Iterable<string> | undefined,
) => {
  const t = (type ?? "None").toLowerCase().replace(/\s/g, "");
  const list = t.includes("userassigned")
    ? [...(ids ?? [])].map((id) => id.toLowerCase()).sort()
    : [];
  return JSON.stringify([t, list]);
};

const desiredIdentity = (
  identity: MapsAccountIdentity | undefined,
): maps.AccountsCreateOrUpdateRequestIdentity => {
  const type = identity?.type ?? "None";
  return type.includes("UserAssigned")
    ? {
        type,
        userAssignedIdentities: Object.fromEntries(
          (identity?.userAssignedIdentities ?? []).map((id) => [id, {}]),
        ),
      }
    : { type };
};

const corsKey = (rules: readonly { allowedOrigins: readonly string[] }[]) =>
  JSON.stringify(rules.map((rule) => [...rule.allowedOrigins]));

const linkedKey = (
  resources: readonly { uniqueName: string; id: string }[],
) =>
  JSON.stringify(
    [...resources]
      .map((r) => [r.uniqueName, r.id.toLowerCase()])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
  );

const cmkKey = (cmk: maps.CustomerManagedKeyEncryption | undefined) =>
  JSON.stringify([
    cmk?.keyEncryptionKeyUrl ?? null,
    cmk?.keyEncryptionKeyIdentity?.identityType ?? null,
    cmk?.keyEncryptionKeyIdentity?.userAssignedIdentityResourceId?.toLowerCase() ??
      null,
  ]);

const desiredProperties = (
  news: AccountProps,
): maps.MapsAccountPropertiesInput => ({
  disableLocalAuth: news.disableLocalAuth ?? false,
  cors: { corsRules: news.cors ?? [] },
  linkedResources: news.linkedResources ?? [],
  ...(news.customerManagedKeyEncryption !== undefined
    ? {
        encryption: {
          customerManagedKeyEncryption: news.customerManagedKeyEncryption,
        },
      }
    : {}),
});

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["accountName", "accountId", "resourceGroup", "location", "uniqueId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* maps
        .ListAccountBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAccountBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) &&
          group !== undefined &&
          account.name !== undefined
          ? [
              toAttrs(group, account.name, account, {
                primary: undefined,
                secondary: undefined,
              }),
            ]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const newKind = news.kind ?? "Gen2";
      const kindReplaces =
        output.kind !== "" &&
        newKind.toLowerCase() !== output.kind.toLowerCase() &&
        !(output.kind.toLowerCase() === "gen1" && newKind === "Gen2");
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.accountName.toLowerCase()) ||
        (news.location !== undefined &&
          normLocation(news.location) !== normLocation(output.location)) ||
        kindReplaces ||
        (olds !== undefined &&
          (news.infrastructureEncryption ?? false) !==
            (olds.infrastructureEncryption ?? false))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.accountName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.disableLocalAuth ?? false,
      );
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Maps");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accountName ?? (yield* physicalName(id));
      const location =
        news.location ??
        output?.location ??
        (SUPPORTED_LOCATIONS.has(normLocation(env.location) ?? "")
          ? env.location
          : "eastus");
      const sku = news.sku ?? "G2";
      const kind = news.kind ?? "Gen2";
      const tags = yield* desiredTags(id, news.tags);
      const identity = desiredIdentity(news.identity);
      const properties = desiredProperties(news);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const get = getAccount(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure: the PUT is synchronous and carries the full desired state.
      if (observed === undefined) {
        yield* maps.AccountsCreateOrUpdate({
          ...request,
          location,
          sku: { name: sku },
          kind,
          tags,
          identity,
          properties: {
            ...properties,
            ...(news.infrastructureEncryption
              ? {
                  encryption: {
                    ...properties.encryption,
                    infrastructureEncryption: "enabled",
                  },
                }
              : {}),
          },
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const props = observed.properties;
        const propertiesDiffer =
          (props?.disableLocalAuth ?? false) !== properties.disableLocalAuth ||
          corsKey(props?.cors?.corsRules ?? []) !==
            corsKey(properties.cors?.corsRules ?? []) ||
          linkedKey(props?.linkedResources ?? []) !==
            linkedKey(properties.linkedResources ?? []) ||
          (news.customerManagedKeyEncryption !== undefined &&
            cmkKey(props?.encryption?.customerManagedKeyEncryption) !==
              cmkKey(news.customerManagedKeyEncryption));
        const identityDiffers =
          identityKey(
            observed.identity?.type,
            Object.keys(observed.identity?.userAssignedIdentities ?? {}),
          ) !==
          identityKey(
            identity.type,
            Object.keys(identity.userAssignedIdentities ?? {}),
          );
        const patch = {
          ...(observed.sku?.name?.toLowerCase() !== sku.toLowerCase()
            ? { sku: { name: sku } }
            : {}),
          ...((observed.kind ?? "").toLowerCase() !== kind.toLowerCase()
            ? { kind }
            : {}),
          ...(identityDiffers ? { identity } : {}),
          ...(propertiesDiffer ? { properties } : {}),
          ...(tagsDiffer(observed.tags, tags) ? { tags } : {}),
        };
        if (Object.keys(patch).length > 0) {
          yield* maps.UpdateAccount({ ...request, ...patch });
        }
      }

      // Block until usable.
      observed = yield* waitForProvisioned(
        `maps account ${name}`,
        get,
        (account) => account.properties?.provisioningState,
      );
      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.disableLocalAuth ?? false,
      );
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        maps.DeleteAccount({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
        }),
      );
      yield* waitUntilGone(
        `maps account ${output.accountName}`,
        getAccount(subscriptionId, output.resourceGroup, output.accountName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
