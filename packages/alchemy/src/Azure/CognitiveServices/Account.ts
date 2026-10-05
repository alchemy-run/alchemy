import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
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
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  stackAndStage,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ACCOUNT_BUDGET,
  type CognitiveServicesIdentity,
  createAccountName,
  identityDiffers,
  MANAGED_NETWORK_ACCOUNT_BUDGET,
  sameArm,
  sameValue,
  toIdentityInput,
  whileAccountBusy,
} from "./Common.ts";

export type AccountKind =
  | "AIServices"
  | "OpenAI"
  | "CognitiveServices"
  | "TextAnalytics"
  | "ComputerVision"
  | "SpeechServices"
  | "FormRecognizer"
  | "ContentSafety"
  | "Face"
  | "TextTranslation"
  | (string & {});

export interface AccountNetworkAcls {
  /** Action when no IP or virtual network rule matches. */
  defaultAction: "Allow" | "Deny";
  /** Let trusted Azure services bypass the rules. */
  bypass?: "None" | "AzureServices";
  /** Allowed IPv4 addresses or CIDR ranges. */
  ipRules?: string[];
  /** ARM resource IDs of allowed virtual network subnets. */
  virtualNetworkRules?: string[];
}

export interface AccountNetworkInjection {
  /** Scenario the injection applies to. */
  scenario: "agent" | "none";
  /** ARM ID of a delegated subnet to inject into. */
  subnetArmId?: string;
  /**
   * Use a Microsoft-managed virtual network instead of your own subnet
   * (required by `CognitiveServices.ManagedNetwork`).
   */
  useMicrosoftManagedNetwork?: boolean;
}

export interface AccountProps {
  /** Resource group the account is created in. Changing it replaces the account. */
  resourceGroup: string;
  /**
   * Account name: 2-64 letters, digits, and hyphens. If omitted, a unique
   * lowercase name is generated from the app, stage, and logical ID.
   * Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Kind of service (`AIServices` for Azure AI Foundry / multi-service,
   * `OpenAI`, `TextAnalytics`, ...). Changing it replaces the account.
   * @default "AIServices"
   */
  kind?: AccountKind;
  /**
   * Pricing tier. `F0` (free) is limited to one account per kind per
   * subscription.
   * @default "S0"
   */
  sku?: string;
  /**
   * Globally unique subdomain of the account endpoint
   * (`https://{customSubDomainName}.cognitiveservices.azure.com/`).
   * Required for Microsoft Entra ID auth, network rules, and projects. It
   * cannot be changed once set; changing it replaces the account.
   * @default the account name
   */
  customSubDomainName?: string;
  /**
   * Managed identity of the account. Foundry projects and customer-managed
   * keys need a system-assigned identity.
   */
  identity?: CognitiveServicesIdentity;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** Network rules for the public endpoint. */
  networkAcls?: AccountNetworkAcls;
  /**
   * Disable key-based (local) authentication so callers must use
   * Microsoft Entra ID.
   * @default false
   */
  disableLocalAuth?: boolean;
  /**
   * Allow the account to hold Azure AI Foundry projects. Required by
   * `CognitiveServices.Project`; it cannot be turned off while projects
   * exist.
   * @default false
   */
  allowProjectManagement?: boolean;
  /** Project targeted by data-plane calls that do not name a project. */
  defaultProject?: string;
  /** Restrict outbound calls of the account to `allowedFqdnList`. */
  restrictOutboundNetworkAccess?: boolean;
  /** FQDNs the account may call when outbound access is restricted. */
  allowedFqdnList?: string[];
  /**
   * Network injection for Foundry agents: your own delegated subnet, or a
   * Microsoft-managed network (`useMicrosoftManagedNetwork: true`).
   */
  networkInjections?: AccountNetworkInjection[];
  /** Enable dynamic throttling. */
  dynamicThrottlingEnabled?: boolean;
  /** Disable stored completions (Azure OpenAI). */
  storedCompletionsDisabled?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.CognitiveServices.Account",
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
    /** Kind of service. */
    kind: string;
    /** Pricing tier. */
    sku: string;
    /** Custom subdomain of the account endpoint. */
    customSubDomainName: string | undefined;
    /** Primary endpoint, e.g. `https://{subdomain}.cognitiveservices.azure.com/`. */
    endpoint: string | undefined;
    /** Endpoints by API name (e.g. `OpenAI Language Model Instance API`). */
    endpoints: Record<string, string>;
    /** Object ID of the account's system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure AI services account (`Microsoft.CognitiveServices/accounts`):
 * the root resource of Azure AI Foundry, Azure OpenAI, and the single
 * Azure AI services (Language, Vision, Speech, Content Safety, ...).
 *
 * Deleting an account only soft-deletes it, which keeps its name and
 * subdomain reserved for 48 hours. Alchemy purges the deleted account so
 * the name can be reused immediately.
 *
 * @see https://learn.microsoft.com/azure/ai-services/multi-service-resource
 *
 * ### Creating an Account
 * **Example:** Azure AI services (Foundry) account
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("ai");
 * const account = yield* Azure.CognitiveServices.Account("ai", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Azure OpenAI account with Entra ID only
 * ```typescript
 * const openai = yield* Azure.CognitiveServices.Account("openai", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "OpenAI",
 *   disableLocalAuth: true,
 * });
 * ```
 *
 * ### Azure AI Foundry
 * **Example:** Account that can hold Foundry projects
 * ```typescript
 * const foundry = yield* Azure.CognitiveServices.Account("foundry", {
 *   resourceGroup: group.resourceGroupName,
 *   kind: "AIServices",
 *   allowProjectManagement: true,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * ### Network Restrictions
 * **Example:** Allow only one IP range
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("ai", {
 *   resourceGroup: group.resourceGroupName,
 *   networkAcls: { defaultAction: "Deny", ipRules: ["203.0.113.0/24"] },
 * });
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Azure.CognitiveServices.Account");

type ObservedAccount = cognitiveservices.GetAccountResponse;

export const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetAccount({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );

/** Whether an observed account is injected into a Microsoft-managed network. */
export const usesMicrosoftManagedNetwork = (
  account: cognitiveservices.GetAccountResponse | undefined,
) =>
  account?.properties?.networkInjections?.some(
    (injection) => injection.useMicrosoftManagedNetwork === true,
  ) === true;

export const getDeletedAccount = (
  subscriptionId: string,
  location: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetDeletedAccount({
      subscriptionId,
      location,
      resourceGroupName,
      accountName,
    }),
  );

/**
 * Whether the account carries this stack/stage's ownership tags. Used as the
 * ownership signal for children that cannot be tagged (account singletons,
 * capability hosts).
 */
export const isAccountOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) {
  const account = yield* getAccount(
    subscriptionId,
    resourceGroupName,
    accountName,
  );
  if (account === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  return (
    account.tags?.["alchemy::stack"] === stack &&
    account.tags?.["alchemy::stage"] === stage
  );
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: ObservedAccount,
): Account["Attributes"] => ({
  accountName: name,
  accountId: account.id ?? "",
  resourceGroup,
  location: account.location ?? "",
  kind: account.kind ?? "",
  sku: account.sku?.name ?? "",
  customSubDomainName: account.properties?.customSubDomainName,
  endpoint: account.properties?.endpoint,
  endpoints: Object.fromEntries(
    Object.entries(account.properties?.endpoints ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  principalId: account.identity?.principalId,
  tags: userTags(account.tags),
});

const toNetworkAcls = (
  acls: AccountNetworkAcls | undefined,
): cognitiveservices.NetworkRuleSet | undefined =>
  acls === undefined
    ? undefined
    : {
        defaultAction: acls.defaultAction,
        bypass: acls.bypass,
        ipRules: (acls.ipRules ?? []).map((value) => ({ value })),
        virtualNetworkRules: (acls.virtualNetworkRules ?? []).map((id) => ({
          id,
        })),
      };

const networkAclsDiffer = (
  observed: cognitiveservices.NetworkRuleSet | undefined,
  desired: AccountNetworkAcls | undefined,
) => {
  if (desired === undefined) return false;
  const norm = (acls: cognitiveservices.NetworkRuleSet | undefined) => ({
    defaultAction: acls?.defaultAction ?? "Allow",
    bypass: desired.bypass === undefined ? undefined : acls?.bypass,
    ipRules: (acls?.ipRules ?? []).map((rule) => rule.value).sort(),
    virtualNetworkRules: (acls?.virtualNetworkRules ?? [])
      .map((rule) => rule.id.toLowerCase())
      .sort(),
  });
  return !sameValue(norm(observed), norm(toNetworkAcls(desired)));
};

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: [
      "accountName",
      "accountId",
      "resourceGroup",
      "location",
      "kind",
      "customSubDomainName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cognitiveservices
        .ListAccounts({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListAccounts", page)),
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
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameArm(news.name, output.accountName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.kind ?? "AIServices", output.kind) ||
        (news.customSubDomainName !== undefined &&
          output.customSubDomainName !== undefined &&
          !sameArm(news.customSubDomainName, output.customSubDomainName))
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
        output?.accountName ?? olds?.name ?? (yield* createAccountName(id));
      const observed = yield* getAccount(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accountName ?? (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "S0";
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const label = `cognitive services account ${name}`;
      const get = getAccount(subscriptionId, resourceGroup, name);
      const desired = {
        publicNetworkAccess: news.publicNetworkAccess,
        disableLocalAuth: news.disableLocalAuth,
        allowProjectManagement: news.allowProjectManagement,
        defaultProject: news.defaultProject,
        restrictOutboundNetworkAccess: news.restrictOutboundNetworkAccess,
        dynamicThrottlingEnabled: news.dynamicThrottlingEnabled,
        storedCompletionsDisabled: news.storedCompletionsDisabled,
      };

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running PUT.
      if (observed === undefined) {
        yield* cognitiveservices.CreateAccount({
          ...where,
          location,
          kind: news.kind ?? "AIServices",
          sku: { name: sku },
          identity: toIdentityInput(news.identity),
          tags,
          properties: {
            ...desired,
            customSubDomainName: news.customSubDomainName ?? name,
            networkAcls: toNetworkAcls(news.networkAcls),
            allowedFqdnList: news.allowedFqdnList,
            networkInjections: news.networkInjections,
          },
        });
      }
      const budget = news.networkInjections?.some(
        (injection) => injection.useMicrosoftManagedNetwork === true,
      )
        ? MANAGED_NETWORK_ACCOUNT_BUDGET
        : ACCOUNT_BUDGET;
      observed = yield* waitForProvisioned(
        label,
        get,
        (account) => account.properties?.provisioningState,
        budget,
      );

      // Sync each mutable aspect against the observed account; PATCH only
      // the deltas.
      const props = observed.properties ?? {};
      const changed: cognitiveservices.AccountPropertiesInput = {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        const value = desired[key];
        if (value !== undefined && props[key] !== value) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (
        props.customSubDomainName === undefined ||
        props.customSubDomainName === ""
      ) {
        changed.customSubDomainName = news.customSubDomainName ?? name;
      }
      if (networkAclsDiffer(props.networkAcls, news.networkAcls)) {
        changed.networkAcls = toNetworkAcls(news.networkAcls);
      }
      if (
        news.allowedFqdnList !== undefined &&
        !sameValue(
          [...(props.allowedFqdnList ?? [])].sort(),
          [...news.allowedFqdnList].sort(),
        )
      ) {
        changed.allowedFqdnList = news.allowedFqdnList;
      }
      if (
        news.networkInjections !== undefined &&
        !sameValue(
          (props.networkInjections ?? []).map((n) => ({
            ...n,
            subnetArmId: n.subnetArmId?.toLowerCase(),
          })),
          news.networkInjections.map((n) => ({
            ...n,
            subnetArmId: n.subnetArmId?.toLowerCase(),
          })),
        )
      ) {
        changed.networkInjections = news.networkInjections;
      }
      const skuChanged = !sameArm(observed.sku?.name, sku);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (
        Object.keys(changed).length > 0 ||
        skuChanged ||
        tagsChanged ||
        identityChanged
      ) {
        yield* cognitiveservices
          .UpdateAccount({
            ...where,
            sku: skuChanged ? { name: sku } : undefined,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged
              ? toIdentityInput(news.identity)
              : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForProvisioned(
          label,
          get,
          (account) => account.properties?.provisioningState,
          budget,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.accountName,
      };
      const label = `cognitive services account ${output.accountName}`;
      const get = getAccount(
        subscriptionId,
        output.resourceGroup,
        output.accountName,
      );
      const current = yield* get;
      const budget = usesMicrosoftManagedNetwork(current)
        ? MANAGED_NETWORK_ACCOUNT_BUDGET
        : ACCOUNT_BUDGET;
      // An account still creating or updating rejects the delete with a
      // conflict; let it settle (a `Failed` account is deletable, and a
      // `Deleting` one only needs observing).
      if (current !== undefined) {
        yield* waitForProvisioned(
          label,
          get,
          (account) =>
            account.properties?.provisioningState === "Deleting"
              ? "Succeeded"
              : account.properties?.provisioningState,
          budget,
        ).pipe(Effect.ignore);
      }
      // An account already `Deleting` (e.g. an earlier attempt whose request
      // hit the gateway timeout) rejects another DELETE with a conflict that
      // never clears; that delete is ours and only needs observing.
      const alreadyDeleting = get.pipe(
        Effect.map(
          (account) =>
            account === undefined ||
            account.properties?.provisioningState === "Deleting",
        ),
      );
      yield* ignoreNotFound(
        cognitiveservices.DeleteAccount(where).pipe(
          // Tearing down a managed network outlives the ARM gateway; the
          // delete continues server-side and waitUntilGone observes it.
          Effect.catchTag("GatewayTimeout", () => Effect.void),
          Effect.catchTag("CognitiveServicesRequestConflict", (error) =>
            Effect.flatMap(alreadyDeleting, (deleting) =>
              deleting ? Effect.void : Effect.fail(error),
            ),
          ),
          Effect.retry(whileAccountBusy),
        ),
      );
      yield* waitUntilGone(label, get, budget);
      // Deleting only soft-deletes the account; purge it so the name and
      // subdomain are released and nothing lingers.
      const deleted = { ...where, location: output.location };
      yield* ignoreNotFound(cognitiveservices.PurgeDeletedAccount(deleted));
      yield* waitUntilGone(
        `deleted ${label}`,
        getDeletedAccount(
          subscriptionId,
          output.location,
          output.resourceGroup,
          output.accountName,
        ),
        ACCOUNT_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
