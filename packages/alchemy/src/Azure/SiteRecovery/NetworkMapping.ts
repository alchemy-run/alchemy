import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
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
  createSiteRecoveryName,
  ownedOrUnowned,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

/** The ASR network every Azure fabric exposes for Azure-to-Azure mappings. */
export const AZURE_NETWORK = "azureNetwork";

export interface NetworkMappingProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the mapping. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the mapping. */
  vault: string;
  /** Name of the primary fabric. Changing it replaces the mapping. */
  fabric: string;
  /**
   * ASR network of the primary fabric the mapping lives under. Changing it
   * replaces the mapping.
   * @default "azureNetwork"
   */
  network?: string;
  /**
   * Mapping name, unique within the network. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * mapping.
   */
  name?: string;
  /** ARM ID of the primary virtual network. Changing it replaces the mapping. */
  primaryNetworkId: string;
  /** Name of the recovery fabric. Changing it replaces the mapping. */
  recoveryFabric: string;
  /**
   * ARM ID of the recovery virtual network failed-over VMs attach to.
   * Updated in place.
   */
  recoveryNetworkId: string;
}

export interface NetworkMapping extends Resource<
  "Azure.SiteRecovery.NetworkMapping",
  NetworkMappingProps,
  {
    /** Name of the mapping. */
    networkMappingName: string;
    /** ASR network of the primary fabric. */
    network: string;
    /** Name of the primary fabric. */
    fabric: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the mapping. */
    networkMappingId: string;
    /** ARM ID of the primary virtual network. */
    primaryNetworkId: string;
    /** Name of the recovery fabric. */
    recoveryFabric: string;
    /** ARM ID of the recovery virtual network. */
    recoveryNetworkId: string;
    /** Mapping state, e.g. `Paired`. */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery network mapping: maps a primary virtual network to
 * the recovery virtual network that failed-over VMs attach to
 * (Azure-to-Azure).
 *
 * Mappings cannot be tagged; Alchemy treats a mapping as owned when its
 * vault is tagged for the current stack and stage. The recovery network is
 * updated in place; the primary network and fabrics are immutable.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-network-mappings/create
 *
 * ### Azure-to-Azure Disaster Recovery
 * **Example:** Map the primary VNet to the recovery VNet
 * ```typescript
 * yield* Azure.SiteRecovery.NetworkMapping("vnet-mapping", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   fabric: primary.fabricName,
 *   primaryNetworkId: primaryVnet.virtualNetworkId,
 *   recoveryFabric: recovery.fabricName,
 *   recoveryNetworkId: recoveryVnet.virtualNetworkId,
 * });
 * ```
 *
 * @resource
 */
export const NetworkMapping = Resource<NetworkMapping>(
  "Azure.SiteRecovery.NetworkMapping",
);

type Observed = asr.GetReplicationNetworkMappingResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
  fabricName: string;
  networkName: string;
  networkMappingName: string;
}

const getMapping = (where: Where) =>
  orUndefinedIfNotFound(asr.GetReplicationNetworkMapping(where));

const toAttrs = (
  where: Where,
  props: Pick<
    NetworkMappingProps,
    "primaryNetworkId" | "recoveryFabric" | "recoveryNetworkId"
  >,
  observed: Observed,
): NetworkMapping["Attributes"] => ({
  networkMappingName: where.networkMappingName,
  network: where.networkName,
  fabric: where.fabricName,
  vault: where.resourceName,
  resourceGroup: where.resourceGroupName,
  networkMappingId: observed.id ?? "",
  primaryNetworkId:
    observed.properties?.primaryNetworkId ?? props.primaryNetworkId,
  recoveryFabric: props.recoveryFabric,
  recoveryNetworkId:
    observed.properties?.recoveryNetworkId ?? props.recoveryNetworkId,
  state: observed.properties?.state,
});

export const NetworkMappingProvider = () =>
  Provider.succeed(NetworkMapping, {
    stables: [
      "networkMappingName",
      "network",
      "fabric",
      "vault",
      "resourceGroup",
      "networkMappingId",
      "primaryNetworkId",
      "recoveryFabric",
    ],

    // Mappings live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(news.fabric, output.fabric) ||
        !sameName(news.network ?? AZURE_NETWORK, output.network) ||
        (news.name !== undefined &&
          !sameName(news.name, output.networkMappingName)) ||
        !sameName(news.primaryNetworkId, output.primaryNetworkId) ||
        !sameName(news.recoveryFabric, output.recoveryFabric)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const props = output ?? olds;
      if (props === undefined) return undefined;
      const where: Where = {
        subscriptionId,
        resourceGroupName: props.resourceGroup,
        resourceName: props.vault,
        fabricName: props.fabric,
        networkName: output?.network ?? olds?.network ?? AZURE_NETWORK,
        networkMappingName:
          output?.networkMappingName ??
          olds?.name ??
          (yield* createSiteRecoveryName(id)),
      };
      const observed = yield* getMapping(where);
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(where, props, observed),
        output !== undefined,
        subscriptionId,
        props.resourceGroup,
        props.vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        resourceName: news.vault,
        fabricName: news.fabric,
        networkName: news.network ?? AZURE_NETWORK,
        networkMappingName:
          news.name ??
          output?.networkMappingName ??
          (yield* createSiteRecoveryName(id)),
      };
      const fabricSpecificDetails = {
        instanceType: "AzureToAzure",
        primaryNetworkId: news.primaryNetworkId,
      };
      const get = getMapping(where);
      const converged = (mapping: Observed) =>
        sameName(mapping.properties?.recoveryNetworkId, news.recoveryNetworkId)
          ? undefined
          : "Updating";

      // Observe.
      const observed = yield* get;

      // Ensure / sync: create when missing, PATCH the recovery network on a delta.
      if (observed === undefined) {
        yield* asr.CreateReplicationNetworkMapping({
          ...where,
          properties: {
            recoveryFabricName: news.recoveryFabric,
            recoveryNetworkId: news.recoveryNetworkId,
            fabricSpecificDetails,
          },
        });
      } else if (converged(observed) !== undefined) {
        yield* asr.UpdateReplicationNetworkMapping({
          ...where,
          properties: {
            recoveryFabricName: news.recoveryFabric,
            recoveryNetworkId: news.recoveryNetworkId,
            fabricSpecificDetails: {
              instanceType: "AzureToAzure",
              primaryNetworkId: news.primaryNetworkId,
            },
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `site recovery network mapping ${where.networkMappingName}`,
        get,
        converged,
        { interval: "10 seconds", times: 48 },
      );
      return toAttrs(where, news, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.vault,
        fabricName: output.fabric,
        networkName: output.network,
        networkMappingName: output.networkMappingName,
      };
      yield* ignoreNotFound(asr.DeleteReplicationNetworkMapping(where));
      yield* waitUntilGone(
        `site recovery network mapping ${output.networkMappingName}`,
        getMapping(where),
        { interval: "10 seconds", times: 48 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
