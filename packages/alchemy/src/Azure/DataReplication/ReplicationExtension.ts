import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import * as Effect from "effect/Effect";
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
  createDataReplicationName,
  DATA_REPLICATION_NAMESPACE,
  type DataReplicationCustomProperties,
  matchesDesired,
  ownedByVaultOrUnowned,
  sameName,
} from "./Shared.ts";

export interface ReplicationExtensionProps {
  /** Resource group of the vault. Changing it replaces the extension. */
  resourceGroup: string;
  /** Name of the data replication vault. Changing it replaces the extension. */
  vault: string;
  /**
   * Name of the extension: letters and digits only. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the extension.
   */
  name?: string;
  /**
   * Source/target fabric pairing, discriminated by `instanceType`:
   * - `HyperVToAzStackHCI` — `{ hyperVFabricArmId, azStackHciFabricArmId,
   *   storageAccountId?, storageAccountSasSecretName? }`
   * - `VMwareToAzStackHCI` — `{ vmwareFabricArmId, azStackHciFabricArmId,
   *   storageAccountId?, storageAccountSasSecretName? }`
   *
   * The service does not apply a re-PUT to an existing extension, so any
   * change replaces the extension.
   */
  customProperties: DataReplicationCustomProperties;
}

export interface ReplicationExtension extends Resource<
  "Azure.DataReplication.ReplicationExtension",
  ReplicationExtensionProps,
  {
    /** Name of the extension. */
    replicationExtensionName: string;
    /** Name of the vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the extension. */
    replicationExtensionId: string;
    /** Provisioning state of the extension. */
    provisioningState: string | undefined;
    /** Observed extension settings. */
    customProperties: Record<string, unknown> | undefined;
  },
  never,
  Providers
> {}

/**
 * A replication extension in an Azure Site Recovery data replication vault
 * (`Microsoft.DataReplication/replicationVaults/replicationExtensions`):
 * pairs a source fabric (Hyper-V or VMware) with an Azure Local (Azure
 * Stack HCI) target fabric and the cache storage account replication
 * uses. Protected items replicate through an extension.
 *
 * Both fabrics must exist and be healthy; with missing fabrics the service
 * accepts the PUT and the extension ends in `Failed`.
 *
 * Extensions cannot be tagged; Alchemy treats one as owned when its vault
 * is tagged for the current stack and stage.
 *
 * @see https://learn.microsoft.com/rest/api/datareplication/replication-extension/create
 *
 * ### Creating a Replication Extension
 * **Example:** Hyper-V to Azure Local
 * ```typescript
 * const extension = yield* Azure.DataReplication.ReplicationExtension("ext", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   customProperties: {
 *     instanceType: "HyperVToAzStackHCI",
 *     hyperVFabricArmId: source.fabricId,
 *     azStackHciFabricArmId: target.fabricId,
 *     storageAccountId: cache.storageAccountId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ReplicationExtension = Resource<ReplicationExtension>(
  "Azure.DataReplication.ReplicationExtension",
);

type Observed = dr.GetReplicationExtensionResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  vaultName: string;
  replicationExtensionName: string;
}

const getExtension = (where: Where) =>
  orUndefinedIfNotFound(dr.GetReplicationExtension(where));

const customOf = (observed: Observed) =>
  (observed.properties?.customProperties ?? undefined) as
    | Record<string, unknown>
    | undefined;

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  observed: Observed,
): ReplicationExtension["Attributes"] => ({
  replicationExtensionName: name,
  vault,
  resourceGroup,
  replicationExtensionId: observed.id ?? "",
  provisioningState: observed.properties?.provisioningState,
  customProperties: customOf(observed),
});

export const ReplicationExtensionProvider = () =>
  Provider.succeed(ReplicationExtension, {
    stables: [
      "replicationExtensionName",
      "vault",
      "resourceGroup",
      "replicationExtensionId",
    ],

    // A vault child that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        (news.name !== undefined &&
          !sameName(news.name, output.replicationExtensionName)) ||
        (olds !== undefined &&
          !matchesDesired(olds.customProperties, news.customProperties))
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
        output?.replicationExtensionName ??
        olds?.name ??
        (yield* createDataReplicationName(id));
      const observed = yield* getExtension({
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: vault,
        replicationExtensionName: name,
      });
      if (observed === undefined) return undefined;
      return yield* ownedByVaultOrUnowned(
        toAttrs(resourceGroup, vault, name, observed),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DATA_REPLICATION_NAMESPACE);
      const name =
        news.name ??
        output?.replicationExtensionName ??
        (yield* createDataReplicationName(id));
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        vaultName: news.vault,
        replicationExtensionName: name,
      };
      const get = getExtension(where);

      // Observe; PUT (an upsert LRO) only when missing or failed.
      const observed = yield* get;
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed"
      ) {
        yield* dr.CreateReplicationExtension({
          ...where,
          properties: { customProperties: news.customProperties },
        });
      }
      const fresh = yield* waitForProvisioned(
        `data replication extension ${name}`,
        get,
        (extension) => extension.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(news.resourceGroup, news.vault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vaultName: output.vault,
        replicationExtensionName: output.replicationExtensionName,
      };
      yield* ignoreNotFound(dr.DeleteReplicationExtension(where));
      yield* waitUntilGone(
        `data replication extension ${output.replicationExtensionName}`,
        getExtension(where),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.DataReplication.Vault"] },
  });
