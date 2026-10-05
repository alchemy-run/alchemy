import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import * as Data from "effect/Data";
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
  ProvisioningTimedOut,
  resourceGroupOf,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  BACKUP_FABRIC,
  isVaultOwnedByStack,
  RECOVERY_SERVICES_NAMESPACE,
  sameId,
} from "./BackupShared.ts";

export type BackupContainerType = "StorageContainer" | "VMAppContainer";

export interface BackupProtectionContainerProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the container. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the container. */
  vault: string;
  /**
   * Kind of container: `StorageContainer` registers a storage account for
   * Azure Files backup, `VMAppContainer` registers a VM for SQL/SAP HANA
   * workload backup (the VM name and its resource group name must total
   * at most 84 characters). Changing it replaces the container.
   * @default "StorageContainer"
   */
  containerType?: BackupContainerType;
  /**
   * ARM ID of the resource to register: the storage account (for
   * `StorageContainer`) or the virtual machine (for `VMAppContainer`).
   * Changing it replaces the container.
   */
  sourceResourceId: string;
  /**
   * Container name. Derived from the source resource when omitted
   * (`StorageContainer;Storage;<rg>;<account>` or
   * `VMAppContainer;Compute;<rg>;<vm>`). Changing it replaces the container.
   */
  containerName?: string;
  /**
   * Workload type inside a `VMAppContainer`, e.g. `SQLDataBase` or
   * `SAPHanaDatabase`. Changing it replaces the container.
   */
  workloadType?: string;
  /**
   * Whether Azure Backup places an `AzureBackupProtectionLock` delete lock
   * on the storage account (`StorageContainer` only).
   * @default unmanaged
   */
  acquireStorageAccountLock?: "Acquire" | "NotAcquire";
}

export interface BackupProtectionContainer extends Resource<
  "Azure.RecoveryServices.BackupProtectionContainer",
  BackupProtectionContainerProps,
  {
    /** Name of the container; pass it as a protected item's `containerName`. */
    containerName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** Backup fabric of the container (always `Azure`). */
    fabricName: string;
    /** ARM resource ID of the container. */
    containerId: string;
    /** Kind of container. */
    containerType: string;
    /** ARM ID of the registered resource. */
    sourceResourceId: string;
    /** Registration status, `Registered` once usable. */
    registrationStatus: string;
    /** Health status of the container. */
    healthStatus: string;
  },
  never,
  Providers
> {}

/**
 * Registers a storage account (or a VM running SQL/SAP HANA) with a
 * Recovery Services vault so its file shares (or databases) can be backed
 * up with {@link BackupProtectedItem}.
 *
 * Containers cannot be tagged; Alchemy treats a container as owned when
 * its vault is tagged for the current stack and stage. Destroying the
 * resource unregisters the container (all its protected items must be
 * removed first).
 *
 * @see https://learn.microsoft.com/azure/backup/backup-azure-file-share-rest-api
 *
 * ### Azure Files
 * **Example:** Register a storage account for Azure Files backup
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const container = yield* Azure.RecoveryServices.BackupProtectionContainer(
 *   "files-container",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     vault: vault.vaultName,
 *     sourceResourceId: account.storageAccountId,
 *   },
 * );
 * ```
 *
 * **Example:** Register without the storage account delete lock
 * ```typescript
 * yield* Azure.RecoveryServices.BackupProtectionContainer("files-container", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   sourceResourceId: account.storageAccountId,
 *   acquireStorageAccountLock: "NotAcquire",
 * });
 * ```
 *
 * @resource
 */
export const BackupProtectionContainer = Resource<BackupProtectionContainer>(
  "Azure.RecoveryServices.BackupProtectionContainer",
);

export class BackupContainerNotDiscovered extends Data.TaggedError(
  "Azure.RecoveryServices.BackupContainerNotDiscovered",
)<{
  readonly containerName: string;
  readonly message: string;
}> {}

/**
 * Azure Backup's workload (SQL/SAP HANA in VM) registration job fails
 * without a usable error when the VM name and its resource group name
 * together exceed 84 characters; the provider rejects such sources up
 * front.
 */
export class BackupWorkloadVmNameTooLong extends Data.TaggedError(
  "Azure.RecoveryServices.BackupWorkloadVmNameTooLong",
)<{
  readonly sourceResourceId: string;
  readonly message: string;
}> {}

/** Azure Backup's limit on VM name + resource group name for workloads. */
const MAX_WORKLOAD_VM_NAME_LENGTH = 84;

type Observed = backup.GetProtectionContainerResponse;

const nameOf = (armId: string) => armId.split("/").filter(Boolean).at(-1) ?? "";

/** Default container name for a source resource. */
export const backupContainerName = (
  containerType: BackupContainerType,
  sourceResourceId: string,
) =>
  containerType === "StorageContainer"
    ? `StorageContainer;Storage;${resourceGroupOf(sourceResourceId)};${nameOf(sourceResourceId)}`
    : `VMAppContainer;Compute;${resourceGroupOf(sourceResourceId)};${nameOf(sourceResourceId)}`;

const managementTypeOf = (containerType: BackupContainerType) =>
  containerType === "StorageContainer" ? "AzureStorage" : "AzureWorkload";

const getContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  containerName: string,
) =>
  orUndefinedIfNotFound(
    backup.GetProtectionContainer({
      subscriptionId,
      resourceGroupName,
      vaultName,
      fabricName: BACKUP_FABRIC,
      containerName,
    }),
  );

const isRegistered = (observed: Observed | undefined) =>
  (observed?.properties?.registrationStatus ?? "").toLowerCase() ===
  "registered";

/** A workload registration still installing the backup extension. */
const isRegistering = (observed: Observed | undefined) =>
  (observed?.properties?.registrationStatus ?? "").toLowerCase() ===
  "registering";

/**
 * Polls (5 s apart) for a registration to finish: storage containers
 * register in about a minute, workload (VMAppContainer) registrations
 * install the backup extension on the VM and take up to ~10 minutes.
 */
const registrationPolls = (containerType: BackupContainerType) =>
  containerType === "StorageContainer" ? 15 : 150;

const toAttrs = (
  resourceGroup: string,
  vault: string,
  containerName: string,
  observed: Observed,
): BackupProtectionContainer["Attributes"] => ({
  containerName,
  vault,
  resourceGroup,
  fabricName: BACKUP_FABRIC,
  containerId: observed.id ?? "",
  containerType: observed.properties?.containerType ?? "",
  sourceResourceId: observed.properties?.sourceResourceId ?? "",
  registrationStatus: observed.properties?.registrationStatus ?? "",
  healthStatus: observed.properties?.healthStatus ?? "",
});

export const BackupProtectionContainerProvider = () =>
  Provider.succeed(BackupProtectionContainer, {
    stables: [
      "containerName",
      "vault",
      "resourceGroup",
      "fabricName",
      "containerId",
    ],

    // Containers live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const containerType = news.containerType ?? "StorageContainer";
      const containerName =
        news.containerName ??
        backupContainerName(containerType, news.sourceResourceId);
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.vault.toLowerCase() !== output.vault.toLowerCase() ||
        !sameId(containerName, output.containerName) ||
        (output.sourceResourceId !== "" &&
          !sameId(news.sourceResourceId, output.sourceResourceId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      const containerName =
        output?.containerName ??
        olds?.containerName ??
        (olds?.sourceResourceId !== undefined
          ? backupContainerName(
              olds.containerType ?? "StorageContainer",
              olds.sourceResourceId,
            )
          : undefined);
      if (
        resourceGroup === undefined ||
        vault === undefined ||
        containerName === undefined
      ) {
        return undefined;
      }
      const observed = yield* getContainer(
        subscriptionId,
        resourceGroup,
        vault,
        containerName,
      );
      if (observed === undefined || !isRegistered(observed)) return undefined;
      const attrs = toAttrs(resourceGroup, vault, containerName, observed);
      return output !== undefined ||
        (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, RECOVERY_SERVICES_NAMESPACE);
      const { resourceGroup, vault, sourceResourceId } = news;
      const containerType = news.containerType ?? "StorageContainer";
      const backupManagementType = managementTypeOf(containerType);
      const containerName =
        news.containerName ??
        backupContainerName(containerType, sourceResourceId);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: vault,
      };
      const get = getContainer(
        subscriptionId,
        resourceGroup,
        vault,
        containerName,
      );

      // Observe.
      const observed = yield* get;
      // GET does not always echo the lock setting; fall back to the last
      // applied value.
      const observedLock =
        observed?.properties?.acquireStorageAccountLock ??
        olds?.acquireStorageAccountLock;
      const lockDrift =
        news.acquireStorageAccountLock !== undefined &&
        observedLock !== undefined &&
        observedLock.toLowerCase() !==
          news.acquireStorageAccountLock.toLowerCase();

      if (containerType === "VMAppContainer") {
        const length =
          (resourceGroupOf(sourceResourceId) ?? "").length +
          nameOf(sourceResourceId).length;
        if (length > MAX_WORKLOAD_VM_NAME_LENGTH) {
          return yield* new BackupWorkloadVmNameTooLong({
            sourceResourceId,
            message: `Azure Backup cannot register ${sourceResourceId}: the VM name and resource group name are ${length} characters together (max ${MAX_WORKLOAD_VM_NAME_LENGTH})`,
          });
        }
      }

      if (!isRegistered(observed) && !isRegistering(observed)) {
        // Ensure: the vault only registers resources it has discovered, so
        // refresh discovery and wait for the resource to show up first.
        yield* backup.RefreshProtectionContainer({
          ...where,
          fabricName: BACKUP_FABRIC,
          _filter: `backupManagementType eq '${backupManagementType}'`,
        });
        yield* backup
          .ListProtectableContainers({
            ...where,
            fabricName: BACKUP_FABRIC,
            _filter: `backupManagementType eq '${backupManagementType}'`,
          })
          .pipe(
            Effect.flatMap((page) =>
              (page.value ?? []).some((c) => sameId(c.name, containerName))
                ? Effect.void
                : Effect.fail("pending" as const),
            ),
            Effect.retry({
              while: (e) => e === "pending",
              schedule: Schedule.spaced("5 seconds"),
              times: 24,
            }),
            Effect.catchIf(
              (e): e is "pending" => e === "pending",
              () =>
                Effect.fail(
                  new BackupContainerNotDiscovered({
                    containerName,
                    message: `${sourceResourceId} was not discovered as a protectable ${containerType} after 2 minutes`,
                  }),
                ),
            ),
          );
      }
      const register = backup
        .RegisterProtectionContainer({
          ...where,
          fabricName: BACKUP_FABRIC,
          containerName,
          properties: {
            containerType,
            backupManagementType,
            sourceResourceId,
            workloadType: news.workloadType,
            acquireStorageAccountLock: news.acquireStorageAccountLock,
            // A workload registration that carries `friendlyName` or
            // `operationType: "Register"` fails with `CloudInternalError`;
            // only re-registration names its operation.
            ...(containerType === "VMAppContainer"
              ? isRegistered(observed)
                ? { operationType: "Reregister" }
                : {}
              : { friendlyName: nameOf(sourceResourceId) }),
          },
        })
        .pipe(
          // A registration that is still running is awaited below.
          Effect.catchTag(
            "BackupContainerRegistrationInProgress",
            () => Effect.void,
          ),
        );
      const untilRegistered = get.pipe(
        Effect.flatMap((container) =>
          container !== undefined && isRegistered(container)
            ? Effect.succeed(container)
            : Effect.fail("pending" as const),
        ),
        Effect.retry({
          while: (e) => e === "pending",
          schedule: Schedule.spaced("5 seconds"),
          times: registrationPolls(containerType),
        }),
      );
      const fresh = yield* (
        (!isRegistered(observed) && !isRegistering(observed)) || lockDrift
          ? // Ensure / sync: (re-)register with the desired settings. The
            // asynchronous registration job intermittently fails with an
            // internal error and leaves no container; registering again
            // succeeds, so a registration that does not show up is retried.
            register.pipe(
              Effect.andThen(untilRegistered),
              Effect.retry({
                while: (e) => e === "pending",
                times: 3,
              }),
            )
          : untilRegistered
      ).pipe(
        Effect.catchIf(
          (e): e is "pending" => e === "pending",
          () =>
            Effect.fail(
              new ProvisioningTimedOut({
                resource: `backup container ${containerName}`,
                state: undefined,
                message: `backup container ${containerName} was not registered after 4 attempts`,
              }),
            ),
        ),
      );
      return toAttrs(resourceGroup, vault, containerName, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getContainer(
        subscriptionId,
        output.resourceGroup,
        output.vault,
        output.containerName,
      );
      // A workload registration cannot be undone while it is still
      // installing the backup extension; let it settle first.
      yield* get.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (container) => !isRegistering(container),
          times: 150,
        }),
      );
      yield* ignoreNotFound(
        backup.UnregisterProtectionContainer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.vault,
          fabricName: BACKUP_FABRIC,
          containerName: output.containerName,
        }),
      );
      yield* waitUntilGone(
        `backup container ${output.containerName}`,
        get.pipe(
          Effect.map((container) =>
            isRegistered(container) || isRegistering(container)
              ? container
              : undefined,
          ),
        ),
        { interval: "5 seconds", times: 48 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.RecoveryServices.BackupProtectedItem",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
