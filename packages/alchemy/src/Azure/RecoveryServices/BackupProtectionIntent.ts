import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  BACKUP_FABRIC,
  createBackupName,
  isVaultOwnedByStack,
  RECOVERY_SERVICES_NAMESPACE,
  sameId,
} from "./BackupShared.ts";

export type BackupProtectionIntentItemType =
  | "RecoveryServiceVaultItem"
  | "AzureWorkloadSQLAutoProtectionIntent"
  | "AzureWorkloadAutoProtectionIntent"
  | "AzureWorkloadContainerAutoProtectionIntent"
  | "AzureResourceItem";

export interface BackupProtectionIntentProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the intent. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the intent. */
  vault: string;
  /**
   * Intent object name, e.g. the workload item name. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the intent.
   */
  name?: string;
  /**
   * Kind of intent. `RecoveryServiceVaultItem` with the protectable SQL
   * instance (or availability group) as `itemId` auto-protects every
   * current and future database in it; Azure Backup rejects the other
   * kinds for SQL auto-protection with `BMSUserErrorInvalidInput`.
   * Changing it replaces the intent.
   * @default "RecoveryServiceVaultItem"
   */
  protectionIntentItemType?: BackupProtectionIntentItemType;
  /**
   * Workload family of the intent.
   * @default "AzureWorkload"
   */
  backupManagementType?: "AzureWorkload" | "AzureIaasVM";
  /**
   * ARM ID of the source (the VM hosting the workload). Not needed for
   * `RecoveryServiceVaultItem` intents. Changing it replaces the intent.
   */
  sourceResourceId?: string;
  /**
   * ID of the item to auto-protect, e.g. the protectable SQL instance's
   * ARM ID. Changing it replaces the intent.
   */
  itemId?: string;
  /** Workload item type to auto-protect, e.g. `SQLInstance`. Changing it replaces the intent. */
  workloadItemType?: string;
  /** ARM ID of the {@link BackupPolicy} applied to auto-protected items. */
  policyId: string;
}

export interface BackupProtectionIntent extends Resource<
  "Azure.RecoveryServices.BackupProtectionIntent",
  BackupProtectionIntentProps,
  {
    /** Name of the intent object. */
    intentObjectName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the intent. */
    protectionIntentId: string;
    /** ARM ID of the policy applied by the intent. */
    policyId: string;
    /** Observed protection state of the intent. */
    protectionState: string;
  },
  never,
  Providers
> {}

/**
 * A backup protection intent: auto-protects workloads (for example every
 * current and future database of a SQL Server instance in an Azure VM)
 * with a {@link BackupPolicy}.
 *
 * Intents cannot be tagged; Alchemy treats an intent as owned when its
 * vault is tagged for the current stack and stage. Creating the intent
 * immediately configures backup for the instance's existing databases
 * (including `master`, `model`, and `msdb`). Changing the policy updates
 * the intent in place, but Azure Backup rejects it with
 * `BackupProtectionOperationInProgress` while that configuration is still
 * running; destroying the intent stops auto-protection (already protected
 * items stay protected).
 *
 * @see https://learn.microsoft.com/azure/backup/backup-sql-server-database-azure-vms#enable-auto-protection
 *
 * ### SQL Server in Azure VMs
 * **Example:** Auto-protect a SQL instance
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // The VM is registered with BackupProtectionContainer; the SQL instance
 * // ID comes from the vault's protectable items after an inquiry.
 * yield* Azure.RecoveryServices.BackupProtectionIntent("sql-auto", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   itemId: sqlInstanceItemId,
 *   policyId: sqlPolicy.policyId,
 * });
 * ```
 *
 * @resource
 */
export const BackupProtectionIntent = Resource<BackupProtectionIntent>(
  "Azure.RecoveryServices.BackupProtectionIntent",
);

type Observed = backup.GetProtectionIntentResponse;

const DEFAULT_ITEM_TYPE: BackupProtectionIntentItemType =
  "RecoveryServiceVaultItem";

/**
 * Azure Backup rejects intent writes while the previous configure-protection
 * operation on the same item is still running (e.g. a policy switch right
 * after creation); retry for up to ~5 minutes.
 */
const retryWhileConfiguring = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
) =>
  self.pipe(
    Effect.retry({
      while: (e) => e._tag === "BackupProtectionOperationInProgress",
      schedule: Schedule.spaced("10 seconds"),
      times: 30,
    }),
  );

const getIntent = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  intentObjectName: string,
) =>
  orUndefinedIfNotFound(
    backup.GetProtectionIntent({
      subscriptionId,
      resourceGroupName,
      vaultName,
      fabricName: BACKUP_FABRIC,
      intentObjectName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  observed: Observed,
): BackupProtectionIntent["Attributes"] => ({
  intentObjectName: name,
  vault,
  resourceGroup,
  protectionIntentId: observed.id ?? "",
  policyId: observed.properties?.policyId ?? "",
  protectionState: observed.properties?.protectionState ?? "",
});

export const BackupProtectionIntentProvider = () =>
  Provider.succeed(BackupProtectionIntent, {
    stables: [
      "intentObjectName",
      "vault",
      "resourceGroup",
      "protectionIntentId",
    ],

    // Intents live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.vault.toLowerCase() !== output.vault.toLowerCase() ||
        (news.name !== undefined &&
          !sameId(news.name, output.intentObjectName)) ||
        (olds !== undefined &&
          ((news.protectionIntentItemType ?? DEFAULT_ITEM_TYPE) !==
            (olds.protectionIntentItemType ?? DEFAULT_ITEM_TYPE) ||
            !sameId(news.sourceResourceId, olds.sourceResourceId) ||
            !sameId(news.itemId, olds.itemId) ||
            !sameId(news.workloadItemType, olds.workloadItemType)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const name =
        output?.intentObjectName ?? olds?.name ?? (yield* createBackupName(id));
      const observed = yield* getIntent(
        subscriptionId,
        resourceGroup,
        vault,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, name, observed);
      return output !== undefined ||
        (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, RECOVERY_SERVICES_NAMESPACE);
      const { resourceGroup, vault } = news;
      const name =
        news.name ?? output?.intentObjectName ?? (yield* createBackupName(id));
      const get = getIntent(subscriptionId, resourceGroup, vault, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync the policy (everything else is immutable).
      if (
        observed === undefined ||
        !sameId(observed.properties?.policyId, news.policyId)
      ) {
        yield* retryWhileConfiguring(
          backup.ProtectionIntentCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            vaultName: vault,
            fabricName: BACKUP_FABRIC,
            intentObjectName: name,
            properties: {
              protectionIntentItemType:
                news.protectionIntentItemType ?? DEFAULT_ITEM_TYPE,
              backupManagementType:
                news.backupManagementType ?? "AzureWorkload",
              sourceResourceId: news.sourceResourceId,
              itemId: news.itemId,
              policyId: news.policyId,
              workloadItemType: news.workloadItemType,
            },
          }),
        );
      }

      const fresh = yield* waitForProvisioned(
        `backup protection intent ${name}`,
        get.pipe(
          Effect.map((intent) =>
            intent !== undefined &&
            sameId(intent.properties?.policyId, news.policyId)
              ? intent
              : undefined,
          ),
        ),
        () => undefined,
        { interval: "5 seconds", times: 24 },
      );
      return toAttrs(resourceGroup, vault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        retryWhileConfiguring(
          backup.DeleteProtectionIntent({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            vaultName: output.vault,
            fabricName: BACKUP_FABRIC,
            intentObjectName: output.intentObjectName,
          }),
        ),
      );
      yield* waitUntilGone(
        `backup protection intent ${output.intentObjectName}`,
        getIntent(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          output.intentObjectName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
