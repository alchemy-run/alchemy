import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import * as Effect from "effect/Effect";
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
  createDataReplicationName,
  DATA_REPLICATION_NAMESPACE,
  sameName,
} from "./Shared.ts";

export type DataReplicationVaultType = "DisasterRecovery" | "Migrate";

export interface VaultProps {
  /**
   * Resource group the vault is created in. Changing it replaces the vault.
   */
  resourceGroup: string;
  /**
   * Name of the vault: letters and digits only. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the vault.
   */
  name?: string;
  /**
   * Azure location of the vault. Changing it replaces the vault.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Purpose of the vault: `DisasterRecovery` (Hyper-V/VMware to Azure Local
   * replication) or `Migrate` (Azure Migrate). Changing it replaces the
   * vault.
   * @default "DisasterRecovery"
   */
  vaultType?: DataReplicationVaultType;
  /**
   * Whether the vault accepts traffic from public networks. Set to
   * `Disabled` to allow only private endpoints.
   * @default unmanaged (Azure default `Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Managed identity of the vault. `SystemAssigned` gives the vault a
   * service principal it uses to reach storage and fabrics. The service
   * rejects vaults created without a managed identity, so new vaults get a
   * system-assigned identity unless `None` is requested explicitly.
   * @default "SystemAssigned" on create; unmanaged afterwards
   */
  identity?: "None" | "SystemAssigned";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Vault extends Resource<
  "Azure.DataReplication.Vault",
  VaultProps,
  {
    /** Name of the vault. */
    vaultName: string;
    /** Resource group that holds the vault. */
    resourceGroup: string;
    /** ARM resource ID of the vault. */
    vaultId: string;
    /** Location of the vault. */
    location: string;
    /** Purpose of the vault (`DisasterRecovery` or `Migrate`). */
    vaultType: string | undefined;
    /** Observed public network access setting. */
    publicNetworkAccess: string | undefined;
    /** ID of the backing service resource Azure created for the vault. */
    serviceResourceId: string | undefined;
    /** Observed managed identity type. */
    identityType: string | undefined;
    /** Object ID of the vault's system-assigned identity, if any. */
    principalId: string | undefined;
    /** Provisioning state of the vault. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery data replication vault (`Microsoft.DataReplication`)
 * — the container for the newer Site Recovery stack that replicates
 * Hyper-V and VMware machines to Azure Local (Azure Stack HCI) and backs
 * Azure Migrate. Fabrics, replication policies, replication extensions, and
 * protected items all hang off a vault.
 *
 * The vault itself is free; charges accrue per protected instance.
 *
 * @see https://learn.microsoft.com/azure/azure-local/migrate/migration-azure-migrate-overview
 *
 * ### Creating a Vault
 * **Example:** Disaster recovery vault
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("dr");
 * const vault = yield* Azure.DataReplication.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Private vault with a managed identity
 * ```typescript
 * const vault = yield* Azure.DataReplication.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   vaultType: "Migrate",
 *   publicNetworkAccess: "Disabled",
 *   identity: "SystemAssigned",
 *   tags: { team: "infra" },
 * });
 * ```
 *
 * @resource
 */
export const Vault = Resource<Vault>("Azure.DataReplication.Vault");

type ObservedVault = dr.GetVaultResponse;

const getVault = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    dr.GetVault({ subscriptionId, resourceGroupName, vaultName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  vault: ObservedVault,
): Vault["Attributes"] => ({
  vaultName: name,
  resourceGroup,
  vaultId: vault.id ?? "",
  location: vault.location,
  vaultType: vault.properties?.vaultType,
  publicNetworkAccess: vault.properties?.publicNetworkAccess,
  serviceResourceId: vault.properties?.serviceResourceId,
  identityType: vault.identity?.type,
  principalId: vault.identity?.principalId,
  provisioningState: vault.properties?.provisioningState,
  tags: userTags(vault.tags),
});

const identityTypeOf = (vault: ObservedVault) => vault.identity?.type ?? "None";

export const VaultProvider = () =>
  Provider.succeed(Vault, {
    stables: ["vaultName", "resourceGroup", "vaultId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        dr
          .ListVaultBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListVaultBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((vault) => {
        const group = resourceGroupOf(vault.id);
        return hasAnyAlchemyTag(vault.tags) &&
          group !== undefined &&
          vault.name !== undefined
          ? [toAttrs(group, vault.name, vault)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.vaultName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        (output.vaultType !== undefined &&
          !sameName(news.vaultType ?? "DisasterRecovery", output.vaultType))
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
        output?.vaultName ??
        olds?.name ??
        (yield* createDataReplicationName(id));
      const observed = yield* getVault(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DATA_REPLICATION_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.vaultName ??
        (yield* createDataReplicationName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: name,
      };
      const get = getVault(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `data replication vault ${name}`,
        get,
        (vault) => vault.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* dr.CreateVault({
          ...where,
          location,
          tags,
          properties: {
            vaultType: news.vaultType ?? "DisasterRecovery",
            publicNetworkAccess: news.publicNetworkAccess,
          },
          identity: { type: news.identity ?? "SystemAssigned" },
        });
      }
      observed = yield* settle;

      // Sync tags, public network access, and identity against observed
      // state; one PATCH carries only the aspects that drifted.
      const patch: Omit<dr.UpdateVaultRequest, keyof typeof where> = {};
      if (tagsDiffer(observed.tags, tags)) patch.tags = tags;
      if (
        news.publicNetworkAccess !== undefined &&
        !sameName(
          observed.properties?.publicNetworkAccess,
          news.publicNetworkAccess,
        )
      ) {
        patch.properties = { publicNetworkAccess: news.publicNetworkAccess };
      }
      if (
        news.identity !== undefined &&
        !sameName(identityTypeOf(observed), news.identity)
      ) {
        patch.identity = { type: news.identity };
      }
      if (Object.keys(patch).length > 0) {
        yield* dr.UpdateVault({ ...where, ...patch });
        observed = yield* waitForProvisioned(
          `data replication vault ${name}`,
          get,
          (vault) =>
            (patch.tags !== undefined && tagsDiffer(vault.tags, tags)) ||
            (patch.properties !== undefined &&
              !sameName(
                vault.properties?.publicNetworkAccess,
                news.publicNetworkAccess,
              )) ||
            (patch.identity !== undefined &&
              !sameName(identityTypeOf(vault), news.identity))
              ? "Updating"
              : vault.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dr.DeleteVault({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.vaultName,
        }),
      );
      yield* waitUntilGone(
        `data replication vault ${output.vaultName}`,
        getVault(subscriptionId, output.resourceGroup, output.vaultName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
