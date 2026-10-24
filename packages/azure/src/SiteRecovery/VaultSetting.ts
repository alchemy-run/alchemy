import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, orUndefinedIfNotFound, waitForProvisioned } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  ownedOrUnowned,
  retryWhileVaultRegistering,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

/** The vault setting every vault has. */
export const DEFAULT_VAULT_SETTING = "default";

export interface VaultSettingProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the setting. */
  vault: string;
  /**
   * Vault setting name. Every vault has exactly one, `default`.
   * Changing it replaces the setting.
   * @default "default"
   */
  name?: string;
  /**
   * ARM ID of the Azure Migrate server migration solution
   * (`Microsoft.Migrate/migrateProjects/solutions`) the vault reports to.
   * Omit to leave the observed value unchanged.
   */
  migrationSolutionId?: string;
  /**
   * VMware-to-Azure replication provider of the vault, e.g. `VMwareCbt`
   * (agentless) or `InMageRcm` (modernized agent-based). Omit to leave the
   * observed value unchanged.
   */
  vmwareToAzureProviderType?: string;
}

export interface VaultSetting extends Resource<
  "Azure.SiteRecovery.VaultSetting",
  VaultSettingProps,
  {
    /** Name of the vault setting (`default`). */
    vaultSettingName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the vault setting. */
    vaultSettingId: string;
    /** ARM ID of the linked Azure Migrate solution. */
    migrationSolutionId: string | undefined;
    /** VMware-to-Azure replication provider of the vault. */
    vmwareToAzureProviderType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Azure Site Recovery vault settings
 * (`Microsoft.RecoveryServices/vaults/replicationVaultSettings`): the
 * Azure Migrate hub connection and VMware-to-Azure provider type of a
 * Recovery Services vault.
 *
 * Every vault has exactly one vault setting (`default`), so this resource
 * manages that singleton; Alchemy treats it as owned when its vault is
 * tagged for the current stack and stage. Only the fields you set are
 * written. There is no delete API: destroying the resource leaves the
 * setting as it is, and it goes away with its vault.
 *
 * :::caution
 * Changing `resourceGroup`, `vault`, or `name` replaces the vault setting.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-vault-setting/create
 *
 * ### Azure Migrate
 * **Example:** Link a vault to an Azure Migrate server migration tool
 * ```typescript
 * const hub = yield* Azure.Migrate.MigrateProject("hub", {
 *   location: "centralus",
 * });
 * const migration = yield* Azure.Migrate.Solution("migration", {
 *   migrateProject: hub.migrateProjectName,
 *   name: "Servers-Migration-ServerMigration",
 *   tool: "ServerMigration",
 *   purpose: "Migration",
 *   goal: "Servers",
 * });
 * yield* Azure.SiteRecovery.VaultSetting("settings", {
 *   vault: vault.vaultName,
 *   migrationSolutionId: migration.solutionId,
 *   vmwareToAzureProviderType: "VMwareCbt",
 * });
 * ```
 *
 * @resource
 */
export const VaultSetting = GroupedResource<VaultSetting>("Azure.SiteRecovery.VaultSetting");

type Observed = asr.GetReplicationVaultSettingResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
  vaultSettingName: string;
}

const getVaultSetting = (where: Where) =>
  orUndefinedIfNotFound(retryWhileVaultRegistering(asr.GetReplicationVaultSetting(where)));

/** Whether every field the user set has the desired value in Azure. */
const matches = (observed: Observed | undefined, news: VaultSettingProps) =>
  observed !== undefined &&
  (news.migrationSolutionId === undefined ||
    sameName(observed.properties?.migrationSolutionId, news.migrationSolutionId)) &&
  (news.vmwareToAzureProviderType === undefined ||
    sameName(observed.properties?.vmwareToAzureProviderType, news.vmwareToAzureProviderType));

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  observed: Observed,
): VaultSetting["Attributes"] => ({
  vaultSettingName: name,
  vault,
  resourceGroup,
  vaultSettingId: observed.id ?? "",
  migrationSolutionId: observed.properties?.migrationSolutionId,
  vmwareToAzureProviderType: observed.properties?.vmwareToAzureProviderType,
});

export const VaultSettingProvider = () =>
  Provider.succeed(VaultSetting, {
    stables: ["vaultSettingName", "vault", "resourceGroup", "vaultSettingId"],

    // A vault singleton that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(news.name ?? DEFAULT_VAULT_SETTING, output.vaultSettingName)
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
      const name = output?.vaultSettingName ?? olds?.name ?? DEFAULT_VAULT_SETTING;
      const observed = yield* getVaultSetting({
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: vault,
        vaultSettingName: name,
      });
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(resourceGroup, vault, name, observed),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const name = news.name ?? DEFAULT_VAULT_SETTING;
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        resourceName: news.vault,
        vaultSettingName: name,
      };

      // Observe; the PUT is an upsert of the singleton, sent only on a delta.
      const observed = yield* getVaultSetting(where);
      if (observed !== undefined && matches(observed, news)) {
        return toAttrs(news.resourceGroup, news.vault, name, observed);
      }
      yield* retryWhileVaultRegistering(
        asr.CreateReplicationVaultSetting({
          ...where,
          properties: {
            migrationSolutionId:
              news.migrationSolutionId ?? observed?.properties?.migrationSolutionId,
            vmwareToAzureProviderType:
              news.vmwareToAzureProviderType ?? observed?.properties?.vmwareToAzureProviderType,
          },
        }),
      );
      const fresh = yield* waitForProvisioned(
        `site recovery vault setting ${name}`,
        getVaultSetting(where),
        (setting) => (matches(setting, news) ? undefined : "Updating"),
        { interval: "5 seconds", times: 24 },
      );
      return toAttrs(news.resourceGroup, news.vault, name, fresh);
    }),

    // No delete API: the singleton stays as it is and goes away with its vault.
    delete: Effect.fn(function* () {}),

    nuke: { singleton: true },
  });
