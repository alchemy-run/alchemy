import * as crypto from "node:crypto";
import * as recoveryservices from "@distilled.cloud/azure/recoveryservices";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { isVaultOwnedByStack, RECOVERY_SERVICES_NAMESPACE } from "./BackupShared.ts";

export interface VaultExtendedInfoProps {
  /**
   * Resource group of the Recovery Services vault.
   *
   * :::caution
   * Changing it replaces the resource.
   * :::
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the Recovery Services vault.
   *
   * :::caution
   * Changing it replaces the resource.
   * :::
   */
  vault: string;
  /**
   * Integrity key the vault's registration clients (MARS agent, DPM, Azure
   * Backup Server) use to sign vault credentials. Write-once: it cannot be
   * changed after it is set.
   * @default the key already set on the vault, else a random 128-bit base64 key
   */
  integrityKey?: Redacted.Redacted<string>;
  /**
   * Encryption key of the vault credentials. Write-once.
   * @default the key already set on the vault, else none
   */
  encryptionKey?: Redacted.Redacted<string>;
  /**
   * Thumbprint of `encryptionKey`. Write-once.
   * @default the thumbprint already set on the vault, else none
   */
  encryptionKeyThumbprint?: string;
  /**
   * Algorithm of the extended information. Write-once.
   * @default "None"
   */
  algorithm?: string;
}

export interface VaultExtendedInfo extends Resource<
  "Azure.RecoveryServices.VaultExtendedInfo",
  VaultExtendedInfoProps,
  {
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID (`.../extendedInformation/vaultExtendedInfo`). */
    extendedInfoId: string;
    /** Observed integrity key. */
    integrityKey: Redacted.Redacted<string> | undefined;
    /** Observed encryption key thumbprint. */
    encryptionKeyThumbprint: string | undefined;
    /** Observed algorithm. */
    algorithm: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The extended information of a Recovery Services vault
 * (`Microsoft.RecoveryServices/vaults/extendedInformation`): the integrity
 * and encryption keys that the vault's registration clients (MARS agent,
 * DPM, Azure Backup Server) use for vault credentials.
 *
 * This is a singleton: every vault has at most one, named
 * `vaultExtendedInfo`. Azure has no delete operation for it, so destroying
 * the resource leaves the keys on the vault; they go away with the vault.
 *
 * :::caution
 * The extended info is write-once. After it is set, Azure rejects every
 * change (HTTP 412), so changing `integrityKey`, `encryptionKey`,
 * `encryptionKeyThumbprint`, or `algorithm` fails with the typed
 * `VaultExtendedInfoAlreadySet` error. Settings that already match converge
 * without a write. To change the keys, create a new vault.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/recoveryservices/vault-extended-info
 *
 * ### Vault Credentials
 * **Example:** Set the vault's integrity key
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault");
 * const info = yield* Azure.RecoveryServices.VaultExtendedInfo("vault-info", {
 *   vault: vault.vaultName,
 * });
 * // info.integrityKey is the (generated) key, as a Redacted value
 * ```
 *
 * **Example:** Bring your own key
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault");
 * const integrityKey = yield* Config.redacted("VAULT_INTEGRITY_KEY");
 * yield* Azure.RecoveryServices.VaultExtendedInfo("vault-info", {
 *   vault: vault.vaultName,
 *   integrityKey,
 *   algorithm: "None",
 * });
 * ```
 *
 * @resource
 */
export const VaultExtendedInfo = GroupedResource<VaultExtendedInfo>(
  "Azure.RecoveryServices.VaultExtendedInfo",
);

type Observed = recoveryservices.GetVaultExtendedInfoResponse;

const getInfo = (subscriptionId: string, resourceGroupName: string, vaultName: string) =>
  orUndefinedIfNotFound(
    recoveryservices.GetVaultExtendedInfo({ subscriptionId, resourceGroupName, vaultName }),
  );

/**
 * ARM ID of the extended info. Built here because Azure returns the ID
 * without the `/` before `extendedInformation`.
 */
const extendedInfoId = (subscriptionId: string, resourceGroup: string, vault: string) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/${RECOVERY_SERVICES_NAMESPACE}/vaults/${vault}/extendedInformation/vaultExtendedInfo`;

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  vault: string,
  observed: Observed,
): VaultExtendedInfo["Attributes"] => {
  const props = observed.properties;
  return {
    vault,
    resourceGroup,
    extendedInfoId: extendedInfoId(subscriptionId, resourceGroup, vault),
    integrityKey: props?.integrityKey ? Redacted.make(props.integrityKey) : undefined,
    encryptionKeyThumbprint: props?.encryptionKeyThumbprint,
    algorithm: props?.algorithm,
  };
};

const reveal = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

const generateKey = Effect.sync(() => crypto.randomBytes(16).toString("base64"));

export const VaultExtendedInfoProvider = () =>
  Provider.succeed(VaultExtendedInfo, {
    stables: ["vault", "resourceGroup", "extendedInfoId"],

    // A per-vault singleton that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.vault.toLowerCase() !== output.vault.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const observed = yield* getInfo(subscriptionId, resourceGroup, vault);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, resourceGroup, vault, observed);
      return output !== undefined ||
        (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, RECOVERY_SERVICES_NAMESPACE);
      const { resourceGroup, vault } = news;
      const where = { subscriptionId, resourceGroupName: resourceGroup, vaultName: vault };

      // Observe.
      const observed = yield* getInfo(subscriptionId, resourceGroup, vault);
      const current = observed?.properties;

      // Desired state: keep the observed integrity key unless one is given.
      const integrityKey =
        reveal(news.integrityKey) ?? current?.integrityKey ?? (yield* generateKey);
      const desired: recoveryservices.VaultExtendedInfo = {
        integrityKey,
        encryptionKey: reveal(news.encryptionKey) ?? current?.encryptionKey,
        encryptionKeyThumbprint: news.encryptionKeyThumbprint ?? current?.encryptionKeyThumbprint,
        algorithm: news.algorithm ?? current?.algorithm ?? "None",
      };

      // Ensure: create when missing. The info is write-once, so a PUT on
      // existing info that differs fails with `VaultExtendedInfoAlreadySet`.
      if (
        observed !== undefined &&
        current?.integrityKey === desired.integrityKey &&
        current?.encryptionKey === desired.encryptionKey &&
        current?.encryptionKeyThumbprint === desired.encryptionKeyThumbprint &&
        current?.algorithm === desired.algorithm
      ) {
        return toAttrs(subscriptionId, resourceGroup, vault, observed);
      }
      const written = yield* recoveryservices.VaultExtendedInfoCreateOrUpdate({
        ...where,
        ifMatch: observed?.etag,
        properties: desired,
      });
      return toAttrs(subscriptionId, resourceGroup, vault, written);
    }),

    // Azure has no delete operation; the info is removed with its vault.
    delete: Effect.fn(function* () {}),

    nuke: { singleton: true },
  });
