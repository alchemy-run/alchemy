import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
import {
  CHILD_BUDGET,
  containsValue,
  createChildName,
  sameArm,
  whileAccountBusy,
} from "./Common.ts";

export interface EncryptionScopeKeyVaultProperties {
  /** Key Vault URI, e.g. `https://my-vault.vault.azure.net/`. */
  keyVaultUri: string;
  /** Name of the key. */
  keyName: string;
  /** Key version. If omitted, the latest version is used. */
  keyVersion?: string;
  /** Client ID of the user-assigned identity that reads the key. */
  identityClientId?: string;
}

export interface EncryptionScopeProps {
  /** Resource group of the account. Changing it replaces the scope. */
  resourceGroup: string;
  /** Account (kind `AIServices`) that holds the scope. Changing it replaces the scope. */
  account: string;
  /**
   * Encryption scope name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the scope.
   */
  name?: string;
  /**
   * Who manages the key: Microsoft (`Microsoft.CognitiveServices`) or you
   * (`Microsoft.KeyVault`, requires `keyVaultProperties`).
   * @default "Microsoft.KeyVault"
   */
  keySource?: "Microsoft.CognitiveServices" | "Microsoft.KeyVault";
  /** Customer-managed key settings (`keySource: "Microsoft.KeyVault"`). */
  keyVaultProperties?: EncryptionScopeKeyVaultProperties;
  /**
   * Whether the scope is enabled.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface EncryptionScope extends Resource<
  "Azure.CognitiveServices.EncryptionScope",
  EncryptionScopeProps,
  {
    /** Name of the encryption scope. */
    encryptionScopeName: string;
    /** ARM resource ID of the encryption scope. */
    encryptionScopeId: string;
    /** Account that holds the scope. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Key source. */
    keySource: string | undefined;
    /** Current state. */
    state: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An encryption scope (`Microsoft.CognitiveServices/accounts/encryptionScopes`)
 * that encrypts a subset of an Azure AI Foundry account's data with its own
 * customer-managed key from Azure Key Vault.
 *
 * Encryption scopes are only available for `AIServices` accounts in some
 * regions; elsewhere Azure rejects them with
 * `CognitiveServicesEncryptionScopeNotSupported`.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/concepts/encryption-keys-portal
 *
 * ### Creating an Encryption Scope
 * **Example:** Customer-managed key from Key Vault
 * ```typescript
 * const scope = yield* Azure.CognitiveServices.EncryptionScope("tenant-a", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   keyVaultProperties: {
 *     keyVaultUri: vault.vaultUri,
 *     keyName: "tenant-a",
 *     identityClientId: identity.clientId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const EncryptionScope = Resource<EncryptionScope>(
  "Azure.CognitiveServices.EncryptionScope",
);

const getScope = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  encryptionScopeName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetEncryptionScope({
      subscriptionId,
      resourceGroupName,
      accountName,
      encryptionScopeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  scope: cognitiveservices.GetEncryptionScopeResponse,
): EncryptionScope["Attributes"] => ({
  encryptionScopeName: name,
  encryptionScopeId: scope.id ?? "",
  account,
  resourceGroup,
  keySource: scope.properties?.keySource,
  state: scope.properties?.state,
  tags: userTags(scope.tags),
});

export const EncryptionScopeProvider = () =>
  Provider.succeed(EncryptionScope, {
    stables: [
      "encryptionScopeName",
      "encryptionScopeId",
      "account",
      "resourceGroup",
    ],

    // Encryption scopes live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.encryptionScopeName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.encryptionScopeName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getScope(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name =
        news.name ??
        output?.encryptionScopeName ??
        (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const properties: cognitiveservices.EncryptionScopePropertiesInput = {
        keySource: news.keySource ?? "Microsoft.KeyVault",
        keyVaultProperties: news.keyVaultProperties,
        state: news.state ?? "Enabled",
      };
      const get = getScope(subscriptionId, resourceGroup, account, name);

      // Observe; the PUT is a synchronous upsert sent only on a delta.
      const observed = yield* get;
      const props = observed?.properties;
      if (
        observed === undefined ||
        props?.keySource !== properties.keySource ||
        props?.state !== properties.state ||
        (news.keyVaultProperties !== undefined &&
          !containsValue(props?.keyVaultProperties as Record<string, unknown>, {
            ...news.keyVaultProperties,
          })) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* cognitiveservices
          .EncryptionScopesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            encryptionScopeName: name,
            properties,
            tags,
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `encryption scope ${name}`,
        get,
        (scope) => scope.properties?.provisioningState,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteEncryptionScope({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            encryptionScopeName: output.encryptionScopeName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `encryption scope ${output.encryptionScopeName}`,
        getScope(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.encryptionScopeName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
