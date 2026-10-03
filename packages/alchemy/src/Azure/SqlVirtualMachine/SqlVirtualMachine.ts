import * as sqlvm from "@distilled.cloud/azure/sqlvirtualmachine";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonicalJson,
  lower,
  matchesObserved,
  nameOf,
  sameId,
  unredact,
} from "./common.ts";

/** Domain account passwords used when the SQL VM joins a WSFC group. */
export interface SqlVirtualMachineWsfcDomainCredentials {
  /** Password of the cluster bootstrap account. */
  clusterBootstrapAccountPassword?: Redacted.Redacted<string>;
  /** Password of the cluster operator account. */
  clusterOperatorAccountPassword?: Redacted.Redacted<string>;
  /** Password of the SQL service account. */
  sqlServiceAccountPassword?: Redacted.Redacted<string>;
}

/** Automated backup of the SQL Server databases to a storage account. */
export interface SqlVirtualMachineAutoBackupSettings extends Omit<
  sqlvm.AutoBackupSettings,
  "password" | "storageAccessKey"
> {
  /** Storage account key backups are written with. Write-only. */
  storageAccessKey?: Redacted.Redacted<string>;
  /** Backup encryption password. Write-only. */
  password?: Redacted.Redacted<string>;
}

/** Azure Key Vault integration (SQL Server EKM / TDE credentials). */
export interface SqlVirtualMachineKeyVaultCredentialSettings extends Omit<
  sqlvm.KeyVaultCredentialSettings,
  "servicePrincipalSecret"
> {
  /** Secret of the service principal that reads the key vault. Write-only. */
  servicePrincipalSecret?: Redacted.Redacted<string>;
}

export interface SqlVirtualMachineProps {
  /**
   * Resource group of the underlying virtual machine. Changing it replaces
   * the registration.
   */
  resourceGroup: string;
  /**
   * ARM ID of the Windows virtual machine running SQL Server (typically
   * created from a `MicrosoftSQLServer` image). The SQL VM resource takes
   * the VM's name. Changing it replaces the registration.
   */
  virtualMachineId: string;
  /**
   * Azure location; must equal the virtual machine's location. Changing it
   * replaces the registration.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * SQL Server license: `PAYG` (pay as you go), `AHUB` (Azure Hybrid
   * Benefit), or `DR` (free disaster-recovery replica).
   * @default "PAYG"
   */
  sqlServerLicenseType?: "PAYG" | "AHUB" | "DR";
  /**
   * SQL IaaS Agent management mode. Deprecated by Azure (the mode is
   * detected automatically); only set it when an older API requires it.
   */
  sqlManagement?: "Full" | "LightWeight" | "NoAgent";
  /** SQL image offer, e.g. `SQL2022-WS2022`. */
  sqlImageOffer?: string;
  /** SQL Server edition. Changing it re-registers the edition in place. */
  sqlImageSku?: "Developer" | "Express" | "Standard" | "Enterprise" | "Web";
  /** Run the SQL IaaS Agent with least privilege. */
  leastPrivilegeMode?: "Enabled" | "NotSet";
  /**
   * ARM ID of the `SqlVirtualMachineGroup` (WSFC cluster) to join.
   */
  sqlVirtualMachineGroupResourceId?: string;
  /** Domain account passwords for joining the WSFC group. Write-only. */
  wsfcDomainCredentials?: SqlVirtualMachineWsfcDomainCredentials;
  /** Static IP of the WSFC cluster (multi-subnet setups). */
  wsfcStaticIp?: string;
  /** Automated patching window for Windows and SQL Server updates. */
  autoPatchingSettings?: sqlvm.AutoPatchingSettings;
  /** Automated backup settings. */
  autoBackupSettings?: SqlVirtualMachineAutoBackupSettings;
  /** Azure Key Vault integration settings. Write-only. */
  keyVaultCredentialSettings?: SqlVirtualMachineKeyVaultCredentialSettings;
  /**
   * Connectivity, workload, storage, instance, and Entra ID settings applied
   * by the SQL IaaS Agent. Write-only: changes are detected against the
   * previous props.
   */
  serverConfigurationsManagementSettings?: sqlvm.ServerConfigurationsManagementSettings;
  /**
   * Data/log/tempdb storage layout. Write-only: changes are detected
   * against the previous props.
   */
  storageConfigurationSettings?: sqlvm.StorageConfigurationSettings;
  /** SQL best practices assessment settings. */
  assessmentSettings?: sqlvm.AssessmentSettings;
  /** Automatically upgrade the SQL IaaS Agent extension. */
  enableAutomaticUpgrade?: boolean;
  /** Identity the SQL IaaS Agent uses (e.g. for Entra ID authentication). */
  virtualMachineIdentitySettings?: sqlvm.VirtualMachineIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SqlVirtualMachine extends Resource<
  "Azure.SqlVirtualMachine.SqlVirtualMachine",
  SqlVirtualMachineProps,
  {
    /** Name of the SQL VM resource (equal to the virtual machine name). */
    sqlVirtualMachineName: string;
    /** ARM resource ID of the SQL VM resource. */
    sqlVirtualMachineId: string;
    /** Resource group that holds the SQL VM resource. */
    resourceGroup: string;
    /** Location of the SQL VM resource. */
    location: string;
    /** ARM ID of the underlying virtual machine. */
    virtualMachineId: string;
    /** SQL Server license type. */
    sqlServerLicenseType: string | undefined;
    /** SQL IaaS Agent management mode. */
    sqlManagement: string | undefined;
    /** SQL image offer. */
    sqlImageOffer: string | undefined;
    /** SQL Server edition. */
    sqlImageSku: string | undefined;
    /** ARM ID of the joined SQL VM group, if any. */
    sqlVirtualMachineGroupResourceId: string | undefined;
    /** Operating system of the VM (`Windows` or `Linux`). */
    osType: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A SQL Server on Azure VM registration — registers a virtual machine
 * running SQL Server with the SQL IaaS Agent extension and manages its
 * license, edition, patching, backup, and connectivity settings. Deleting
 * it unregisters the extension; the virtual machine itself is untouched.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/sql-agent-extension-manually-register-single-vm
 *
 * ### Registering a SQL VM
 * **Example:** Register a VM created from a SQL Server image
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("sql", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_D2s_v5",
 *   image: {
 *     publisher: "MicrosoftSQLServer",
 *     offer: "sql2022-ws2022",
 *     sku: "sqldev-gen2",
 *   },
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "sqladmin",
 *   adminPassword: Redacted.make(password),
 *   computerName: "sqlvm",
 * });
 * const sql = yield* Azure.SqlVirtualMachine.SqlVirtualMachine("sql", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachineId: vm.virtualMachineId,
 *   sqlServerLicenseType: "PAYG",
 * });
 * ```
 *
 * ### Managing SQL Server Settings
 * **Example:** Patching window and private connectivity
 * ```typescript
 * yield* Azure.SqlVirtualMachine.SqlVirtualMachine("sql", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachineId: vm.virtualMachineId,
 *   sqlServerLicenseType: "AHUB",
 *   autoPatchingSettings: {
 *     enable: true,
 *     dayOfWeek: "Sunday",
 *     maintenanceWindowStartingHour: 2,
 *     maintenanceWindowDuration: 60,
 *   },
 *   serverConfigurationsManagementSettings: {
 *     sqlConnectivityUpdateSettings: { connectivityType: "PRIVATE", port: 1433 },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SqlVirtualMachine = Resource<SqlVirtualMachine>(
  "Azure.SqlVirtualMachine.SqlVirtualMachine",
);

export class InvalidVirtualMachineId extends Data.TaggedError(
  "Azure.SqlVirtualMachine.InvalidVirtualMachineId",
)<{ readonly virtualMachineId: string; readonly message: string }> {}

type Observed = sqlvm.GetSqlVirtualMachineResponse;

const getSqlVm = (
  subscriptionId: string,
  resourceGroupName: string,
  sqlVirtualMachineName: string,
) =>
  orUndefinedIfNotFound(
    sqlvm.GetSqlVirtualMachine({
      subscriptionId,
      resourceGroupName,
      sqlVirtualMachineName,
      _expand: "*",
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  vm: Observed,
): SqlVirtualMachine["Attributes"] => ({
  sqlVirtualMachineName: name,
  sqlVirtualMachineId: vm.id ?? "",
  resourceGroup,
  location: vm.location,
  virtualMachineId: vm.properties?.virtualMachineResourceId ?? "",
  sqlServerLicenseType: vm.properties?.sqlServerLicenseType,
  sqlManagement: vm.properties?.sqlManagement,
  sqlImageOffer: vm.properties?.sqlImageOffer,
  sqlImageSku: vm.properties?.sqlImageSku,
  sqlVirtualMachineGroupResourceId:
    vm.properties?.sqlVirtualMachineGroupResourceId || undefined,
  osType: vm.properties?.osType,
  tags: userTags(vm.tags),
});

/** Secrets Azure never echoes back. */
const SECRET_KEYS = new Set([
  "password",
  "storageAccessKey",
  "servicePrincipalSecret",
  "sqlAuthUpdatePassword",
]);

const vmNameOf = (virtualMachineId: string) => {
  const name = nameOf(virtualMachineId);
  return name === undefined || !/\/virtualMachines\//i.test(virtualMachineId)
    ? Effect.fail(
        new InvalidVirtualMachineId({
          virtualMachineId,
          message: `'${virtualMachineId}' is not a Microsoft.Compute/virtualMachines resource ID`,
        }),
      )
    : Effect.succeed(name);
};

export const SqlVirtualMachineProvider = () =>
  Provider.succeed(SqlVirtualMachine, {
    stables: [
      "sqlVirtualMachineName",
      "sqlVirtualMachineId",
      "resourceGroup",
      "location",
      "virtualMachineId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        sqlvm.ListSqlVirtualMachines({ subscriptionId }),
      );
      if (page === undefined) return [];
      yield* requireSinglePage("ListSqlVirtualMachines", page);
      return (page.value ?? []).flatMap((vm) => {
        const resourceGroup = resourceGroupOf(vm.id);
        return hasAnyAlchemyTag(vm.tags) &&
          resourceGroup !== undefined &&
          vm.name !== undefined
          ? [toAttrs(resourceGroup, vm.name, vm)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        !sameId(news.virtualMachineId, output.virtualMachineId) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vmId = output?.virtualMachineId || olds?.virtualMachineId;
      if (resourceGroup === undefined || !vmId) return undefined;
      const name = output?.sqlVirtualMachineName ?? nameOf(vmId);
      if (name === undefined) return undefined;
      const observed = yield* getSqlVm(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.SqlVirtualMachine");
      const resourceGroup = news.resourceGroup;
      const name = yield* vmNameOf(news.virtualMachineId);
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        sqlVirtualMachineName: name,
      };
      const label = `SQL virtual machine ${name}`;
      const get = getSqlVm(subscriptionId, resourceGroup, name);
      // Registering installs the SQL IaaS Agent on the VM: minutes.
      const wait = waitForProvisioned(
        label,
        get,
        (vm) => vm.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      const desired = {
        virtualMachineResourceId: news.virtualMachineId,
        sqlServerLicenseType: news.sqlServerLicenseType ?? "PAYG",
        sqlManagement: news.sqlManagement,
        sqlImageOffer: news.sqlImageOffer,
        sqlImageSku: news.sqlImageSku,
        leastPrivilegeMode: news.leastPrivilegeMode,
        sqlVirtualMachineGroupResourceId: news.sqlVirtualMachineGroupResourceId,
        wsfcStaticIp: news.wsfcStaticIp,
        autoPatchingSettings: news.autoPatchingSettings,
        autoBackupSettings: news.autoBackupSettings,
        assessmentSettings: news.assessmentSettings,
        enableAutomaticUpgrade: news.enableAutomaticUpgrade,
        virtualMachineIdentitySettings: news.virtualMachineIdentitySettings,
      };
      // Settings Azure does not echo back: drift is judged against olds.
      const writeOnly = {
        wsfcDomainCredentials: news.wsfcDomainCredentials,
        keyVaultCredentialSettings: news.keyVaultCredentialSettings,
        serverConfigurationsManagementSettings:
          news.serverConfigurationsManagementSettings,
        storageConfigurationSettings: news.storageConfigurationSettings,
      };
      const previousWriteOnly = {
        wsfcDomainCredentials: olds?.wsfcDomainCredentials,
        keyVaultCredentialSettings: olds?.keyVaultCredentialSettings,
        serverConfigurationsManagementSettings:
          olds?.serverConfigurationsManagementSettings,
        storageConfigurationSettings: olds?.storageConfigurationSettings,
      };

      // Observe. Azure may already have registered a VM created from a SQL
      // image (automatic registration): that is an existing resource to
      // converge, not a conflict.
      let observed = yield* get;

      // Ensure + sync settings: the PUT is an upsert of the given settings.
      const drifted =
        observed === undefined ||
        !matchesObserved(desired, observed.properties, SECRET_KEYS) ||
        canonicalJson(writeOnly) !== canonicalJson(previousWriteOnly) ||
        canonicalJson(news.autoBackupSettings) !==
          canonicalJson(olds?.autoBackupSettings);
      if (drifted) {
        yield* sqlvm.SqlVirtualMachinesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: unredact({
            ...desired,
            ...writeOnly,
          }) as sqlvm.SqlVirtualMachinePropertiesInput,
        });
      }
      observed = yield* wait;

      // Sync tags against observed tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* sqlvm.UpdateSqlVirtualMachine({ ...where, tags });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sqlvm.DeleteSqlVirtualMachine({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sqlVirtualMachineName: output.sqlVirtualMachineName,
        }),
      );
      yield* waitUntilGone(
        `SQL virtual machine ${output.sqlVirtualMachineName}`,
        getSqlVm(
          subscriptionId,
          output.resourceGroup,
          output.sqlVirtualMachineName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.SqlVirtualMachine.SqlVirtualMachineGroup",
      ],
    },
  });
