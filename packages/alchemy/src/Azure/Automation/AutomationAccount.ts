import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createAccountName, getAccount } from "./Common.ts";

export type AutomationSkuName = "Free" | "Basic";

export type AutomationIdentityType =
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned"
  | "None";

export interface AutomationAccountIdentity {
  /** Managed identity type. */
  type: AutomationIdentityType;
  /** ARM resource IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

export interface AutomationAccountEncryption {
  /** Who manages the encryption key. */
  keySource: "Microsoft.Automation" | "Microsoft.Keyvault";
  /** Key Vault key used when `keySource` is `Microsoft.Keyvault`. */
  keyVaultProperties?: {
    /** URI of the key vault. */
    keyvaultUri?: string;
    /** Name of the key. */
    keyName?: string;
    /** Version of the key. */
    keyVersion?: string;
  };
  /** ARM resource ID of the user-assigned identity that reads the key. */
  userAssignedIdentity?: string;
}

export interface AutomationAccountProps {
  /** Resource group the account is created in. Changing it replaces the account. */
  resourceGroup: string;
  /**
   * Account name: 6-50 letters, digits, and hyphens, starting with a letter
   * and ending with a letter or digit. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing tier. `Basic` is pay-as-you-go (500 free job minutes per month);
   * `Free` caps job minutes.
   * @default "Basic"
   */
  sku?: AutomationSkuName;
  /**
   * Whether webhooks and agents can reach the account over the public
   * internet.
   * @default Azure's default (`true`)
   */
  publicNetworkAccess?: boolean;
  /**
   * Block requests that use non-Entra ID authentication (e.g. webhooks).
   * @default Azure's default (`false`)
   */
  disableLocalAuth?: boolean;
  /** Encryption settings (customer-managed keys). */
  encryption?: AutomationAccountEncryption;
  /** Managed identity of the account. */
  identity?: AutomationAccountIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AutomationAccount extends Resource<
  "Azure.Automation.AutomationAccount",
  AutomationAccountProps,
  {
    /** Name of the account. */
    automationAccountName: string;
    /** ARM resource ID of the account. */
    automationAccountId: string;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account. */
    location: string;
    /** Pricing tier. */
    sku: string;
    /** Account state (`Ok`, `Unavailable`, `Suspended`). */
    state: string | undefined;
    /** Whether the public endpoints accept traffic. */
    publicNetworkAccess: boolean | undefined;
    /** Whether non-Entra ID authentication is blocked. */
    disableLocalAuth: boolean | undefined;
    /** URL hybrid runbook workers register against. */
    automationHybridServiceUrl: string | undefined;
    /** Managed identity type. */
    identityType: string | undefined;
    /** Principal ID of the system-assigned identity. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity. */
    tenantId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Automation account — the container for runbooks, schedules,
 * shared assets (variables, credentials, certificates, connections),
 * modules, and hybrid worker groups.
 *
 * Deleted accounts are soft-deleted for 30 days. Creating an account with
 * the name and resource group of a soft-deleted one recovers it (with its
 * runbooks and assets) instead of failing — free-trial subscriptions allow
 * only one account per region and count soft-deleted accounts against it.
 *
 * @see https://learn.microsoft.com/azure/automation/overview
 *
 * ### Creating an Automation Account
 * **Example:** Basic account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ops");
 * const account = yield* Azure.Automation.AutomationAccount("ops", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Account with a system-assigned identity
 * ```typescript
 * const account = yield* Azure.Automation.AutomationAccount("ops", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 *   disableLocalAuth: true,
 * });
 * ```
 *
 * @resource
 */
export const AutomationAccount = Resource<AutomationAccount>(
  "Azure.Automation.AutomationAccount",
);

const lower = (value: string | undefined) => value?.toLowerCase();

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: automation.GetAutomationAccountResponse,
): AutomationAccount["Attributes"] => ({
  automationAccountName: name,
  automationAccountId: account.id ?? "",
  resourceGroup,
  location: account.location,
  sku: account.properties?.sku?.name ?? "",
  state: account.properties?.state,
  publicNetworkAccess: account.properties?.publicNetworkAccess,
  disableLocalAuth: account.properties?.disableLocalAuth,
  automationHybridServiceUrl: account.properties?.automationHybridServiceUrl,
  identityType: account.identity?.type,
  principalId: account.identity?.principalId,
  tenantId: account.identity?.tenantId,
  tags: userTags(account.tags),
});

/** Account ID of a soft-deleted account at this resource group and name. */
const findDeletedAccount = Effect.fn(function* (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) {
  const page = yield* automation.ListDeletedAutomationAccountBySubscription({
    subscriptionId,
  });
  const suffix =
    `/resourceGroups/${resourceGroup}/providers/Microsoft.Automation/automationAccounts/${name}`.toLowerCase();
  return (page.value ?? []).find((deleted) =>
    deleted.properties?.automationAccountResourceId
      ?.toLowerCase()
      .endsWith(suffix),
  )?.properties?.automationAccountId;
});

const toIdentityInput = (
  identity: AutomationAccountIdentity,
): automation.IdentityInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities
    ? Object.fromEntries(
        identity.userAssignedIdentities.map((uai) => [uai, {}]),
      )
    : undefined,
});

const identityMatches = (
  desired: AutomationAccountIdentity,
  observed: automation.Identity | undefined,
) => {
  const observedType = (observed?.type ?? "None").replace(/\s/g, "");
  if (
    observedType.toLowerCase() !== desired.type.replace(/\s/g, "").toLowerCase()
  ) {
    return false;
  }
  const want = (desired.userAssignedIdentities ?? [])
    .map((v) => v.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((v) => v.toLowerCase())
    .sort();
  return want.length === have.length && want.every((v, i) => v === have[i]);
};

const toEncryption = (
  encryption: AutomationAccountEncryption,
): automation.EncryptionProperties => ({
  keySource: encryption.keySource,
  keyVaultProperties: encryption.keyVaultProperties,
  identity: encryption.userAssignedIdentity
    ? { userAssignedIdentity: encryption.userAssignedIdentity }
    : undefined,
});

export const AutomationAccountProvider = () =>
  Provider.succeed(AutomationAccount, {
    stables: [
      "automationAccountName",
      "automationAccountId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* automation
        .ListAutomationAccount({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAutomationAccount", page),
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
          lower(news.name) !== lower(output.automationAccountName)) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, ""))
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
        output?.automationAccountName ??
        olds?.name ??
        (yield* createAccountName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.automationAccountName ??
        (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Basic";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: name,
      };
      const get = getAccount(subscriptionId, resourceGroup, name);
      const label = `automation account ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a synchronous upsert. A soft-deleted account
      // with the same name (kept 30 days, and counted against the
      // one-account-per-region trial limit) is recovered instead.
      if (observed === undefined) {
        const create = (recover?: string) =>
          automation.AutomationAccountCreateOrUpdate({
            ...where,
            name,
            location,
            tags,
            identity: news.identity
              ? toIdentityInput(news.identity)
              : undefined,
            properties: {
              sku: { name: sku },
              publicNetworkAccess: news.publicNetworkAccess,
              disableLocalAuth: news.disableLocalAuth,
              encryption: news.encryption
                ? toEncryption(news.encryption)
                : undefined,
              ...(recover
                ? { createMode: "Recover", automationAccountId: recover }
                : {}),
            },
          });
        yield* create().pipe(
          Effect.catchTag("AutomationAccountRegionLimit", (error) =>
            Effect.gen(function* () {
              const deleted = yield* findDeletedAccount(
                subscriptionId,
                resourceGroup,
                name,
              );
              if (deleted === undefined) return yield* Effect.fail(error);
              return yield* create(deleted);
            }),
          ),
        );
        observed = yield* waitForProvisioned(label, get, () => undefined, {
          interval: "2 seconds",
          times: 30,
        });
      }

      // Sync each mutable aspect against the observed account.
      const props = observed.properties ?? {};
      const properties: automation.AutomationAccountCreateOrUpdateProperties =
        {};
      if (props.sku?.name !== sku) properties.sku = { name: sku };
      if (
        news.publicNetworkAccess !== undefined &&
        props.publicNetworkAccess !== news.publicNetworkAccess
      ) {
        properties.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        news.disableLocalAuth !== undefined &&
        props.disableLocalAuth !== news.disableLocalAuth
      ) {
        properties.disableLocalAuth = news.disableLocalAuth;
      }
      if (
        news.encryption !== undefined &&
        (props.encryption?.keySource !== news.encryption.keySource ||
          props.encryption?.keyVaultProperties?.keyName !==
            news.encryption.keyVaultProperties?.keyName ||
          props.encryption?.keyVaultProperties?.keyVersion !==
            news.encryption.keyVaultProperties?.keyVersion)
      ) {
        properties.encryption = toEncryption(news.encryption);
      }
      const identityChanged =
        news.identity !== undefined &&
        !identityMatches(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        Object.keys(properties).length > 0 ||
        identityChanged ||
        tagsChanged
      ) {
        yield* automation.UpdateAutomationAccount({
          ...where,
          properties:
            Object.keys(properties).length > 0 ? properties : undefined,
          identity:
            identityChanged && news.identity
              ? toIdentityInput(news.identity)
              : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitForProvisioned(label, get, () => undefined, {
          interval: "2 seconds",
          times: 30,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteAutomationAccount({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccountName,
        }),
      );
      yield* waitUntilGone(
        `automation account ${output.automationAccountName}`,
        getAccount(
          subscriptionId,
          output.resourceGroup,
          output.automationAccountName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
