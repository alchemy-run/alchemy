import * as deviceupdate from "@distilled.cloud/azure/deviceupdate";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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

export type DeviceUpdateSku = "Free" | "Standard";

export type DeviceUpdateIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface DeviceUpdateAccountIdentity {
  /** Managed identity type. */
  type: DeviceUpdateIdentityType;
  /** ARM IDs of user-assigned identities attached to the account. */
  userAssignedIdentities?: string[];
}

export interface DeviceUpdateAccountEncryption {
  /** Key Vault key URI used for customer-managed key encryption at rest. */
  keyVaultKeyUri?: string;
  /**
   * ARM ID of the user-assigned identity used to reach the key. It must also
   * be listed in `identity.userAssignedIdentities`.
   */
  userAssignedIdentity?: string;
}

export interface AccountProps {
  /** Resource group the account is created in. Changing it replaces the account. */
  resourceGroup: string;
  /**
   * Account name: 3-24 letters, digits, and single hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `Free` allows one account per subscription, one instance,
   * and 10 devices. Changing it replaces the account.
   * @default "Standard"
   */
  sku?: DeviceUpdateSku;
  /**
   * Customer-managed key encryption. Set only at creation; changing it
   * replaces the account.
   */
  encryption?: DeviceUpdateAccountEncryption;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Managed identities of the account. When omitted the account keeps its
   * current identity.
   */
  identity?: DeviceUpdateAccountIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.DeviceUpdate.Account",
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
    /** Pricing tier. */
    sku: string;
    /** API host name, e.g. `{name}.api.adu.microsoft.com`. */
    hostName: string | undefined;
    /** Whether the public endpoint accepts traffic. */
    publicNetworkAccess: string | undefined;
    /** Primary and failover locations of the account. */
    locations: { name: string | undefined; role: string | undefined }[];
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Device Update for IoT Hub account — the top-level container for
 * over-the-air update instances. Connect an account to IoT Hubs through
 * `Azure.DeviceUpdate.Instance`.
 *
 * @see https://learn.microsoft.com/azure/iot-hub-device-update/understand-device-update
 *
 * ### Creating an Account
 * **Example:** Standard account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const account = yield* Azure.DeviceUpdate.Account("updates", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Free account (one per subscription, 10 devices)
 * ```typescript
 * const account = yield* Azure.DeviceUpdate.Account("updates", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Free",
 * });
 * ```
 *
 * ### Network and Identity
 * **Example:** Private account with a system-assigned identity
 * ```typescript
 * const account = yield* Azure.DeviceUpdate.Account("updates", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Disabled",
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Azure.DeviceUpdate.Account");

type ObservedAccount = deviceupdate.GetAccountResponse;

export const createDeviceUpdateAccountName = (id: string) =>
  createPhysicalName({ id, maxLength: 24, lowercase: true, delimiter: "-" });

export const getDeviceUpdateAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    deviceupdate.GetAccount({ subscriptionId, resourceGroupName, accountName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
): Account["Attributes"] => ({
  accountName: name,
  accountId: account.id ?? "",
  resourceGroup,
  location: account.location,
  sku: account.properties?.sku ?? "Standard",
  hostName: account.properties?.hostName,
  publicNetworkAccess: account.properties?.publicNetworkAccess,
  locations: (account.properties?.locations ?? []).map((l) => ({
    name: l.name,
    role: l.role,
  })),
  principalId: account.identity?.principalId,
  tags: userTags(account.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * Device Update keeps the create PUT open after the resource already reports
 * `Succeeded`; a second write meanwhile fails with ARM's
 * `InvalidResourceOperation` "... is active/in-progress" (typed as
 * `HybridNetworkOperationInProgress`) or the RP's own `OperationInProgress`
 * (`DeviceUpdateOperationInProgress`). Wait it out.
 */
const whileOperationInProgress = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "HybridNetworkOperationInProgress" ||
    e._tag === "DeviceUpdateOperationInProgress",
  schedule: Schedule.spaced("10 seconds"),
  times: 36,
} as const;

const normalizeType = (type: string | undefined) =>
  (type ?? "None").replace(/\s/g, "").toLowerCase();

const identityRequest = (
  identity: DeviceUpdateAccountIdentity,
): deviceupdate.CreateAccountRequestIdentity => ({
  type: identity.type,
  userAssignedIdentities:
    identity.userAssignedIdentities && identity.userAssignedIdentities.length
      ? Object.fromEntries(identity.userAssignedIdentities.map((i) => [i, {}]))
      : undefined,
});

const identityDiffers = (
  observed: ObservedAccount["identity"],
  desired: DeviceUpdateAccountIdentity,
) => {
  if (normalizeType(observed?.type) !== normalizeType(desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((k) => k.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((k) => k.toLowerCase())
    .sort();
  return have.join("|") !== want.join("|");
};

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: ["accountName", "accountId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* deviceupdate
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
          ? [toAttrs(group, account.name, account)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.accountName)) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, "")) ||
        (news.sku ?? "Standard") !== output.sku
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.accountName ??
        olds?.name ??
        (yield* createDeviceUpdateAccountName(id));
      const observed = yield* getDeviceUpdateAccount(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DeviceUpdate");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.accountName ??
        (yield* createDeviceUpdateAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const label = `device update account ${name}`;
      const get = getDeviceUpdateAccount(subscriptionId, resourceGroup, name);
      const wait = waitForProvisioned(
        label,
        get,
        (account) => account.properties?.provisioningState,
        { interval: "5 seconds", times: 96 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. PUT is a long-running create-or-update.
      if (observed === undefined) {
        yield* deviceupdate
          .CreateAccount({
            ...where,
            location,
            tags,
            identity: news.identity
              ? identityRequest(news.identity)
              : undefined,
            properties: {
              sku: news.sku ?? "Standard",
              publicNetworkAccess: news.publicNetworkAccess,
              encryption: news.encryption,
            },
          })
          .pipe(Effect.retry(whileOperationInProgress));
      }
      observed = yield* wait;

      // publicNetworkAccess is only settable through a full PUT.
      if (
        news.publicNetworkAccess !== undefined &&
        observed.properties?.publicNetworkAccess !== news.publicNetworkAccess
      ) {
        yield* deviceupdate
          .CreateAccount({
            ...where,
            location: observed.location,
            tags,
            identity: news.identity
              ? identityRequest(news.identity)
              : observed.identity
                ? {
                    type: observed.identity.type,
                    userAssignedIdentities: observed.identity
                      .userAssignedIdentities
                      ? Object.fromEntries(
                          Object.keys(
                            observed.identity.userAssignedIdentities,
                          ).map((k) => [k, {}]),
                        )
                      : undefined,
                  }
                : undefined,
            properties: {
              sku: observed.properties?.sku,
              publicNetworkAccess: news.publicNetworkAccess,
              encryption: observed.properties?.encryption,
            },
          })
          .pipe(Effect.retry(whileOperationInProgress));
        observed = yield* wait;
      }

      // Tags and identity via PATCH, only when they differ from observed.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged =
        news.identity !== undefined &&
        identityDiffers(observed.identity, news.identity);
      if (tagsChanged || identityChanged) {
        yield* deviceupdate
          .UpdateAccount({
            ...where,
            tags: tagsChanged ? tags : undefined,
            identity:
              identityChanged && news.identity
                ? identityRequest(news.identity)
                : undefined,
          })
          .pipe(Effect.retry(whileOperationInProgress));
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceupdate
          .DeleteAccount({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.accountName,
          })
          .pipe(Effect.retry(whileOperationInProgress)),
      );
      yield* waitUntilGone(
        `device update account ${output.accountName}`,
        getDeviceUpdateAccount(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
        ),
        { interval: "5 seconds", times: 96 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
