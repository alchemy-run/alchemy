import * as vi from "@distilled.cloud/azure/vi";
import * as Effect from "effect/Effect";
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

/** Managed identity type of a Video Indexer account. */
export type VideoIndexerIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface VideoIndexerIdentity {
  /** Identity type. */
  type: VideoIndexerIdentityType;
  /** ARM IDs of user-assigned identities attached to the account. */
  userAssignedIdentities?: string[];
}

export interface VideoIndexerOpenAiServices {
  /** ARM ID of the Azure OpenAI (Cognitive Services) account. */
  resourceId: string;
  /**
   * ARM ID of the user-assigned identity used to access the OpenAI
   * account. It must be attached to the Video Indexer account.
   */
  userAssignedIdentity?: string;
}

export interface AccountProps {
  /**
   * Resource group the account is created in. Changing it replaces the
   * account.
   */
  resourceGroup: string;
  /**
   * Account name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the account.
   */
  name?: string;
  /**
   * Azure location of the account. Changing it replaces the account.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Storage account (StorageV2, no hierarchical namespace)
   * that holds indexed media. The storage account cannot be switched, so
   * changing it replaces the account.
   */
  storageAccountId: string;
  /**
   * ARM ID of the user-assigned identity Video Indexer uses to access the
   * storage account. It needs `Storage Blob Data Owner` on the storage
   * account before the Video Indexer account is created. When omitted the
   * system-assigned identity is used.
   */
  storageUserAssignedIdentity?: string;
  /**
   * Managed identities of the account.
   * @default `UserAssigned` with `storageUserAssignedIdentity` when set, else `SystemAssigned`
   */
  identity?: VideoIndexerIdentity;
  /**
   * Azure OpenAI account connected for generative insights.
   * @default none
   */
  openAiServices?: VideoIndexerOpenAiServices;
  /**
   * Whether the account's public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Data-plane ID (GUID) of an existing classic account to connect. Set
   * only when migrating a classic account. Changing it replaces the
   * account.
   */
  accountId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Account extends Resource<
  "Azure.VideoIndexer.Account",
  AccountProps,
  {
    /** Name of the Video Indexer account. */
    accountName: string;
    /** ARM resource ID of the account. */
    videoIndexerAccountId: string;
    /** Data-plane account ID (GUID) used by the Video Indexer API. */
    accountId: string;
    /** Tenant ID of the account. */
    tenantId: string | undefined;
    /** Resource group that holds the account. */
    resourceGroup: string;
    /** Location of the account. */
    location: string;
    /** ARM ID of the connected storage account. */
    storageAccountId: string;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Observed public network access setting. */
    publicNetworkAccess: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure AI Video Indexer account (ARM-based). Indexed media is stored
 * in a Storage account the account reaches through a managed identity.
 * Creating the account is free; indexing is billed per input minute.
 *
 * Grant the identity `Storage Blob Data Owner` on the storage account
 * before creating the Video Indexer account.
 *
 * @see https://learn.microsoft.com/azure/azure-video-indexer/create-account-portal
 *
 * ### Creating an Account
 * **Example:** Account backed by a storage account and a user-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("media");
 * const storage = yield* Azure.Storage.StorageAccount("media", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("indexer", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const grant = yield* Azure.Authorization.RoleAssignment("indexer-storage", {
 *   scope: storage.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataOwner,
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * const indexer = yield* Azure.VideoIndexer.Account("indexer", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccountId: storage.storageAccountId,
 *   storageUserAssignedIdentity: identity.identityId,
 *   // depend on the grant so the identity can reach storage at create
 *   tags: { storageGrant: grant.principalId },
 * });
 * ```
 *
 * ### Network Access
 * **Example:** Disable public network access
 * ```typescript
 * const indexer = yield* Azure.VideoIndexer.Account("indexer", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccountId: storage.storageAccountId,
 *   storageUserAssignedIdentity: identity.identityId,
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Account = Resource<Account>("Azure.VideoIndexer.Account");

type Observed = vi.GetAccountResponse;

const createAccountName = (id: string) =>
  createPhysicalName({ id, maxLength: 50, lowercase: true, delimiter: "-" });

const getAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    vi.GetAccount({ subscriptionId, resourceGroupName, accountName }),
  );

const lower = (value: string | undefined) => value?.toLowerCase();

const toAttrs = (
  resourceGroup: string,
  name: string,
  account: Observed,
): Account["Attributes"] => ({
  accountName: name,
  videoIndexerAccountId: account.id ?? "",
  accountId: account.properties?.accountId ?? "",
  tenantId: account.properties?.tenantId,
  resourceGroup,
  location: account.location,
  storageAccountId: account.properties?.storageServices?.resourceId ?? "",
  principalId: account.identity?.principalId,
  publicNetworkAccess: account.properties?.publicNetworkAccess,
  tags: userTags(account.tags),
});

const desiredIdentity = (news: AccountProps): VideoIndexerIdentity =>
  news.identity ??
  (news.storageUserAssignedIdentity
    ? {
        type: "UserAssigned",
        userAssignedIdentities: [news.storageUserAssignedIdentity],
      }
    : { type: "SystemAssigned" });

const toRequestIdentity = (identity: VideoIndexerIdentity) => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities?.length
    ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
    : undefined,
});

const identityKey = (
  type: string | undefined,
  ids: ReadonlyArray<string> | undefined,
) =>
  JSON.stringify([
    (type ?? "None").toLowerCase().replace(/\s/g, ""),
    [...(ids ?? [])].map((id) => id.toLowerCase()).sort(),
  ]);

export const AccountProvider = () =>
  Provider.succeed(Account, {
    stables: [
      "accountName",
      "videoIndexerAccountId",
      "accountId",
      "resourceGroup",
      "location",
      "storageAccountId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        vi
          .ListAccounts({ subscriptionId })
          .pipe(
            Effect.flatMap((page) => requireSinglePage("ListAccounts", page)),
          ),
      );
      return (page?.value ?? []).flatMap((account) => {
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
        (news.name !== undefined && news.name !== output.accountName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        lower(news.storageAccountId) !== lower(output.storageAccountId) ||
        (news.accountId !== undefined && news.accountId !== output.accountId)
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
      yield* ensureRegistered(subscriptionId, "Microsoft.VideoIndexer");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.accountName ?? (yield* createAccountName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = desiredIdentity(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: name,
      };
      const label = `video indexer account ${name}`;
      const get = getAccount(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* vi.AccountsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toRequestIdentity(identity),
          properties: {
            accountId: news.accountId,
            storageServices: {
              resourceId: news.storageAccountId,
              userAssignedIdentity: news.storageUserAssignedIdentity,
            },
            openAiServices: news.openAiServices,
            publicNetworkAccess: news.publicNetworkAccess,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (account) => account.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Sync mutable aspects against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const properties: vi.AccountPropertiesForPatchRequestInput = {};
      if (
        news.publicNetworkAccess !== undefined &&
        props.publicNetworkAccess !== news.publicNetworkAccess
      ) {
        properties.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        news.storageUserAssignedIdentity !== undefined &&
        lower(props.storageServices?.userAssignedIdentity) !==
          lower(news.storageUserAssignedIdentity)
      ) {
        properties.storageServices = {
          userAssignedIdentity: news.storageUserAssignedIdentity,
        };
      }
      if (
        news.openAiServices !== undefined &&
        (lower(props.openAiServices?.resourceId) !==
          lower(news.openAiServices.resourceId) ||
          lower(props.openAiServices?.userAssignedIdentity) !==
            lower(news.openAiServices.userAssignedIdentity))
      ) {
        properties.openAiServices = news.openAiServices;
      }
      const identityChanged =
        identityKey(
          observed.identity?.type,
          Object.keys(observed.identity?.userAssignedIdentities ?? {}),
        ) !== identityKey(identity.type, identity.userAssignedIdentities);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const propertiesChanged = Object.keys(properties).length > 0;
      if (propertiesChanged || identityChanged || tagsChanged) {
        yield* vi.UpdateAccount({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? toRequestIdentity(identity) : undefined,
          properties: propertiesChanged ? properties : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (account) => account.properties?.provisioningState,
          { interval: "3 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vi.DeleteAccount({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
        }),
      );
      yield* waitUntilGone(
        `video indexer account ${output.accountName}`,
        getAccount(subscriptionId, output.resourceGroup, output.accountName),
        // Deletion takes several minutes.
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
