import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  orUndefinedIfNotFound,
  ProvisioningFailed,
  ProvisioningTimedOut,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  isVaultOwnedByStack,
  RECOVERY_SERVICES_NAMESPACE,
  sameId,
} from "./BackupShared.ts";

export interface BackupEncryptionConfigProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the config. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the config. */
  vault: string;
  /**
   * Key Vault key URI used to encrypt backup data, e.g.
   * `https://my-kv.vault.azure.net/keys/backup-key` (versionless keys
   * auto-rotate). The vault's managed identity needs `get`, `wrapKey`, and
   * `unwrapKey` on the key, and the Key Vault needs soft delete and purge
   * protection.
   */
  keyUri: string;
  /**
   * Subscription of the Key Vault.
   * @default the deployment subscription
   */
  keyVaultSubscriptionId?: string;
  /**
   * Double encryption at the infrastructure layer. Can only be set the
   * first time customer-managed keys are configured. Changing it replaces
   * the config.
   * @default unmanaged
   */
  infrastructureEncryptionState?: "Enabled" | "Disabled";
}

export interface BackupEncryptionConfig extends Resource<
  "Azure.RecoveryServices.BackupEncryptionConfig",
  BackupEncryptionConfigProps,
  {
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the encryption config. */
    encryptionConfigId: string;
    /** `CustomerManaged` once a key is configured. */
    encryptionAtRestType: string;
    /** Observed Key Vault key URI. */
    keyUri: string | undefined;
    /** Status of the last key update, e.g. `Succeeded`. */
    lastUpdateStatus: string;
    /** Observed infrastructure encryption state. */
    infrastructureEncryptionState: string;
  },
  never,
  Providers
> {}

/**
 * Customer-managed key (CMK) encryption of the backup data in a Recovery
 * Services vault (`backupEncryptionConfigs/backupResourceEncryptionConfig`).
 *
 * This is a singleton and a one-way switch: once a vault uses
 * customer-managed keys it cannot go back to platform-managed keys, so
 * destroying the resource leaves the key configured. Changing `keyUri`
 * rotates to another key in place. Configure it before protecting any
 * item.
 *
 * @see https://learn.microsoft.com/azure/backup/encryption-at-rest-with-cmk
 *
 * ### Customer-Managed Keys
 * **Example:** Encrypt backups with a Key Vault key
 * ```typescript
 * yield* Azure.RecoveryServices.BackupEncryptionConfig("backup-cmk", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: "my-vault",
 *   keyUri: "https://my-kv.vault.azure.net/keys/backup-key",
 *   infrastructureEncryptionState: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const BackupEncryptionConfig = Resource<BackupEncryptionConfig>(
  "Azure.RecoveryServices.BackupEncryptionConfig",
);

type Observed = backup.GetBackupResourceEncryptionConfigResponse;

const getConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    backup.GetBackupResourceEncryptionConfig({
      subscriptionId,
      resourceGroupName,
      vaultName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  vault: string,
  observed: Observed,
): BackupEncryptionConfig["Attributes"] => {
  const props = observed.properties ?? {};
  return {
    vault,
    resourceGroup,
    encryptionConfigId: observed.id ?? "",
    encryptionAtRestType: props.encryptionAtRestType ?? "",
    keyUri: props.keyUri || undefined,
    lastUpdateStatus: props.lastUpdateStatus ?? "",
    infrastructureEncryptionState: props.infrastructureEncryptionState ?? "",
  };
};

const converged = (
  observed: Observed | undefined,
  news: BackupEncryptionConfigProps,
) =>
  observed !== undefined &&
  sameId(observed.properties?.encryptionAtRestType, "CustomerManaged") &&
  sameId(observed.properties?.keyUri, news.keyUri) &&
  (news.infrastructureEncryptionState === undefined ||
    sameId(
      observed.properties?.infrastructureEncryptionState,
      news.infrastructureEncryptionState,
    ));

export const BackupEncryptionConfigProvider = () =>
  Provider.succeed(BackupEncryptionConfig, {
    stables: ["vault", "resourceGroup", "encryptionConfigId"],

    // A per-vault singleton that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.vault.toLowerCase() !== output.vault.toLowerCase() ||
        (news.infrastructureEncryptionState !== undefined &&
          output.infrastructureEncryptionState !== "" &&
          !sameId(
            news.infrastructureEncryptionState,
            output.infrastructureEncryptionState,
          ))
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
      const observed = yield* getConfig(subscriptionId, resourceGroup, vault);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, observed);
      return output !== undefined ||
        (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, RECOVERY_SERVICES_NAMESPACE);
      const { resourceGroup, vault } = news;
      const get = getConfig(subscriptionId, resourceGroup, vault);

      // Observe.
      const observed = yield* get;

      // Sync: set (or rotate to) the desired key.
      if (!converged(observed, news)) {
        yield* backup.UpdateBackupResourceEncryptionConfig({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: vault,
          properties: {
            encryptionAtRestType: "CustomerManaged",
            keyUri: news.keyUri,
            subscriptionId: news.keyVaultSubscriptionId ?? subscriptionId,
            infrastructureEncryptionState: news.infrastructureEncryptionState,
          },
        });
      }

      // Key updates apply asynchronously; wait for the vault to report them.
      const fresh = yield* get.pipe(
        Effect.flatMap((config) => {
          const status = (config?.properties?.lastUpdateStatus ?? "").toLowerCase();
          if (status === "failed" || status === "partiallyfailed") {
            return Effect.fail(
              new ProvisioningFailed({
                resource: `backup encryption config of ${vault}`,
                state: status,
                message: `customer-managed key update on vault ${vault} ended in '${status}'`,
              }),
            );
          }
          return converged(config, news) && status !== "initialized"
            ? Effect.succeed(config!)
            : Effect.fail("pending" as const);
        }),
        Effect.retry({
          while: (e) => e === "pending",
          schedule: Schedule.spaced("5 seconds"),
          times: 36,
        }),
        Effect.catchIf(
          (e): e is "pending" => e === "pending",
          () =>
            Effect.fail(
              new ProvisioningTimedOut({
                resource: `backup encryption config of ${vault}`,
                state: undefined,
                message: `customer-managed key on vault ${vault} was not applied after 3 minutes`,
              }),
            ),
        ),
      );
      return toAttrs(resourceGroup, vault, fresh);
    }),

    // Customer-managed keys cannot be switched back to platform-managed
    // keys; the configuration disappears with the vault.
    delete: Effect.fn(function* () {}),

    nuke: { singleton: true },
  });
