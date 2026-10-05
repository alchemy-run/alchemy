import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ensureRegistered, waitForProvisioned, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getVault, isVaultOwnedByStack, lower, sameId } from "./common.ts";
import { normalizePolicies, type VaultPermissions } from "./Vault.ts";

export interface AccessPolicyProps {
  /** Resource group of the vault. Changing it replaces the policy. */
  resourceGroup: string;
  /** Vault the policy applies to. Changing it replaces the policy. */
  vault: string;
  /**
   * Object ID of the user, service principal, managed identity, or group.
   * Changing it replaces the policy.
   */
  objectId: string;
  /**
   * Entra tenant of the identity. Changing it replaces the policy.
   * @default the deploying credential's tenant
   */
  tenantId?: string;
  /**
   * Application ID for a compound identity (an app acting on behalf of the
   * principal). Changing it replaces the policy.
   */
  applicationId?: string;
  /** Permissions granted to the identity. */
  permissions: VaultPermissions;
}

export interface AccessPolicy extends Resource<
  "Azure.KeyVault.AccessPolicy",
  AccessPolicyProps,
  {
    /** Vault the policy applies to. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the vault. */
    vaultId: string;
    /** Object ID of the identity. */
    objectId: string;
    /** Entra tenant of the identity. */
    tenantId: string;
    /** Application ID of a compound identity. */
    applicationId: string | undefined;
    /** Observed permissions. */
    permissions: VaultPermissions;
  },
  never,
  Providers
> {}

/**
 * One access policy entry on an Azure Key Vault that uses access-policy
 * authorization (`enableRbacAuthorization: false`).
 *
 * Use this resource, or the vault's `accessPolicies` prop, but not both on
 * the same vault. Access policies have no tags; an existing entry for the
 * same identity is taken over.
 *
 * @see https://learn.microsoft.com/azure/key-vault/general/assign-access-policy
 *
 * ### Granting Access
 * **Example:** Let a managed identity read secrets
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("legacy", {
 *   resourceGroup: group.resourceGroupName,
 *   enableRbacAuthorization: false,
 * });
 * yield* Azure.KeyVault.AccessPolicy("app-reads-secrets", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   objectId: identity.principalId,
 *   permissions: { secrets: ["get", "list"] },
 * });
 * ```
 *
 * **Example:** Key permissions for disk encryption
 * ```typescript
 * yield* Azure.KeyVault.AccessPolicy("disk-encryption", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   objectId: diskEncryptionSet.principalId,
 *   permissions: { keys: ["get", "wrapKey", "unwrapKey"] },
 * });
 * ```
 *
 * @resource
 */
export const AccessPolicy = Resource<AccessPolicy>(
  "Azure.KeyVault.AccessPolicy",
);

const matches =
  (objectId: string, applicationId: string | undefined) =>
  (entry: keyvault.AccessPolicyEntry) =>
    sameId(entry.objectId, objectId) &&
    sameId(entry.applicationId, applicationId);

const findEntry = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  objectId: string,
  applicationId: string | undefined,
) {
  const vault = yield* getVault(subscriptionId, resourceGroupName, vaultName);
  if (vault === undefined) return undefined;
  const entry = (vault.properties.accessPolicies ?? []).find(
    matches(objectId, applicationId),
  );
  return entry === undefined ? undefined : { vault, entry };
});

const toAttrs = (
  resourceGroup: string,
  vaultName: string,
  vault: keyvault.GetVaultResponse,
  entry: keyvault.AccessPolicyEntry,
): AccessPolicy["Attributes"] => ({
  vault: vaultName,
  resourceGroup,
  vaultId: vault.id ?? "",
  objectId: entry.objectId,
  tenantId: entry.tenantId,
  applicationId: entry.applicationId,
  permissions: entry.permissions as VaultPermissions,
});

export const AccessPolicyProvider = () =>
  Provider.succeed(AccessPolicy, {
    stables: ["vault", "resourceGroup", "vaultId", "objectId", "tenantId"],

    // Entries vanish with their vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.vault) !== lower(output.vault) ||
        !sameId(news.objectId, output.objectId) ||
        !sameId(news.applicationId, output.applicationId) ||
        (news.tenantId !== undefined && !sameId(news.tenantId, output.tenantId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      const objectId = output?.objectId ?? olds?.objectId;
      if (
        resourceGroup === undefined ||
        vault === undefined ||
        objectId === undefined
      ) {
        return undefined;
      }
      const found = yield* findEntry(
        subscriptionId,
        resourceGroup,
        vault,
        objectId,
        output?.applicationId ?? olds?.applicationId,
      );
      if (found === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, found.vault, found.entry);
      return (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const { resourceGroup, vault: vaultName, objectId, applicationId } = news;
      const desired: keyvault.AccessPolicyEntry = {
        tenantId: news.tenantId ?? env.tenantId,
        objectId,
        applicationId,
        permissions: news.permissions,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName,
      };

      // Observe.
      const found = yield* findEntry(
        subscriptionId,
        resourceGroup,
        vaultName,
        objectId,
        applicationId,
      );

      // Sync. `add` merges permissions into an existing entry, so a drifted
      // entry is removed first to converge to exactly the desired set.
      if (
        found === undefined ||
        normalizePolicies([found.entry]) !== normalizePolicies([desired])
      ) {
        if (found !== undefined) {
          yield* keyvault.UpdateVaultAccessPolicy({
            ...where,
            operationKind: "remove",
            properties: { accessPolicies: [found.entry] },
          });
        }
        yield* keyvault.UpdateVaultAccessPolicy({
          ...where,
          operationKind: "add",
          properties: { accessPolicies: [desired] },
        });
      }

      const fresh = yield* waitForProvisioned(
        `access policy for ${objectId}`,
        findEntry(
          subscriptionId,
          resourceGroup,
          vaultName,
          objectId,
          applicationId,
        ),
        () => undefined,
      );
      return toAttrs(resourceGroup, vaultName, fresh.vault, fresh.entry);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const find = findEntry(
        subscriptionId,
        output.resourceGroup,
        output.vault,
        output.objectId,
        output.applicationId,
      );
      const found = yield* find;
      if (found === undefined) return;
      yield* keyvault.UpdateVaultAccessPolicy({
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vaultName: output.vault,
        operationKind: "remove",
        properties: { accessPolicies: [found.entry] },
      });
      yield* waitUntilGone(`access policy for ${output.objectId}`, find);
    }),

    nuke: {
      dependsOn: ["Azure.KeyVault.Vault", "Azure.Resources.ResourceGroup"],
    },
  });
