import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  isOwned,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createManagedHsmKeyName, lower } from "./common.ts";
import {
  type KeyAttrs,
  type KeyCommonProps,
  keySpec,
  toKeyAttrs,
  toKeyProperties,
} from "./Key.ts";

export interface ManagedHsmKeyProps extends KeyCommonProps {
  /** Resource group of the managed HSM. Changing it replaces the key. */
  resourceGroup: string;
  /** Managed HSM that holds the key. Changing it replaces the key. */
  managedHsm: string;
}

export interface ManagedHsmKey extends Resource<
  "Azure.KeyVault.ManagedHsmKey",
  ManagedHsmKeyProps,
  KeyAttrs & {
    /** Managed HSM that holds the key. */
    managedHsm: string;
  },
  never,
  Providers
> {}

/**
 * A key in an Azure Key Vault Managed HSM, managed through Azure Resource
 * Manager.
 *
 * The HSM must be activated (security domain downloaded) first, and an
 * HSM administrator must enable its `AllowKeyManagementOperationsThroughARM`
 * setting; until then ARM rejects key operations with
 * `ManagedHsmArmKeyManagementDisabled`. Key names are limited to 89
 * characters. Like vault
 * keys, ARM can only create these keys: every property change creates a
 * new key, and keys are removed together with their HSM. `kty` defaults
 * to `RSA-HSM`.
 *
 * @see https://learn.microsoft.com/azure/key-vault/managed-hsm/key-management
 *
 * ### Creating a Key
 * **Example:** RSA-HSM key
 * ```typescript
 * const key = yield* Azure.KeyVault.ManagedHsmKey("cmk", {
 *   resourceGroup: group.resourceGroupName,
 *   managedHsm: hsm.managedHsmName,
 *   kty: "RSA-HSM",
 *   keySize: 3072,
 * });
 * ```
 *
 * **Example:** EC-HSM signing key
 * ```typescript
 * const key = yield* Azure.KeyVault.ManagedHsmKey("signing", {
 *   resourceGroup: group.resourceGroupName,
 *   managedHsm: hsm.managedHsmName,
 *   kty: "EC-HSM",
 *   curveName: "P-256",
 *   keyOps: ["sign", "verify"],
 * });
 * ```
 *
 * @resource
 */
export const ManagedHsmKey = Resource<ManagedHsmKey>(
  "Azure.KeyVault.ManagedHsmKey",
);

const getKey = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  keyName: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetManagedHsmKey({
      subscriptionId,
      resourceGroupName,
      name,
      keyName,
    }),
  );

export const ManagedHsmKeyProvider = () =>
  Provider.succeed(ManagedHsmKey, {
    stables: ["keyName", "keyId", "managedHsm", "resourceGroup", "keyUri"],

    // Keys vanish with their HSM.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedHsm) !== lower(output.managedHsm) ||
        (news.name !== undefined && news.name !== output.keyName) ||
        (olds !== undefined && keySpec(news) !== keySpec(olds))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedHsm = output?.managedHsm ?? olds?.managedHsm;
      if (resourceGroup === undefined || managedHsm === undefined) {
        return undefined;
      }
      const name =
        output?.keyName ?? olds?.name ?? (yield* createManagedHsmKeyName(id));
      const observed = yield* getKey(
        subscriptionId,
        resourceGroup,
        managedHsm,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = {
        ...toKeyAttrs(resourceGroup, name, observed),
        managedHsm,
      };
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const { resourceGroup, managedHsm } = news;
      const name =
        news.name ?? output?.keyName ?? (yield* createManagedHsmKeyName(id));

      // Observe, then ensure; the PUT is create-if-not-exist.
      let observed = yield* getKey(
        subscriptionId,
        resourceGroup,
        managedHsm,
        name,
      );
      if (observed === undefined) {
        observed = yield* keyvault.CreateManagedHsmKeyIfNotExist({
          subscriptionId,
          resourceGroupName: resourceGroup,
          name: managedHsm,
          keyName: name,
          tags: yield* desiredTags(id, news.tags),
          properties: toKeyProperties({ ...news, kty: news.kty ?? "RSA-HSM" }),
        });
      }
      return {
        ...toKeyAttrs(resourceGroup, name, observed),
        managedHsm,
      };
    }),

    // ARM has no managed HSM key delete; the key is removed with its HSM.
    delete: Effect.fn(function* () {}),

    nuke: {
      dependsOn: ["Azure.KeyVault.ManagedHsm", "Azure.Resources.ResourceGroup"],
    },
  });
