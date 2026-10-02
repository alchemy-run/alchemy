import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { factoryOwnedByStack } from "./FactoryChild.ts";

export interface ManagedVirtualNetworkProps {
  /** Resource group of the factory. Changing it replaces the managed virtual network. */
  resourceGroup: string;
  /** Name of the factory. Changing it replaces the managed virtual network. */
  factoryName: string;
  /**
   * Managed virtual network name. Data Factory only supports `default`.
   * Changing it replaces the managed virtual network.
   * @default "default"
   */
  name?: string;
}

export interface ManagedVirtualNetwork extends Resource<
  "Azure.DataFactory.ManagedVirtualNetwork",
  ManagedVirtualNetworkProps,
  {
    /** Name of the managed virtual network (`default`). */
    managedVirtualNetworkName: string;
    /** Name of the factory that holds the managed virtual network. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the managed virtual network. */
    managedVirtualNetworkId: string;
    /** Data Factory's internal ID of the managed virtual network. */
    vNetId: string | undefined;
    /** Alias of the managed virtual network. */
    alias: string | undefined;
    /** Entity tag of the current definition. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The managed virtual network of a Data Factory. Azure integration
 * runtimes created inside it reach data stores only through managed
 * private endpoints.
 *
 * Data Factory has no API to delete a managed virtual network: removing
 * this resource from a stack only forgets it, and Azure reclaims it when
 * the factory is deleted.
 *
 * @see https://learn.microsoft.com/azure/data-factory/managed-virtual-network-private-endpoint
 *
 * ### Creating a Managed Virtual Network
 * **Example:** Enable the managed virtual network on a factory
 * ```typescript
 * const factory = yield* Azure.DataFactory.Factory("etl", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const vnet = yield* Azure.DataFactory.ManagedVirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 * });
 * ```
 *
 * ### Private Connectivity
 * **Example:** Managed private endpoint to a storage account
 * ```typescript
 * yield* Azure.DataFactory.ManagedPrivateEndpoint("blob", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   managedVirtualNetworkName: vnet.managedVirtualNetworkName,
 *   privateLinkResourceId: account.storageAccountId,
 *   groupId: "blob",
 * });
 * ```
 *
 * @resource
 */
export const ManagedVirtualNetwork = Resource<ManagedVirtualNetwork>(
  "Azure.DataFactory.ManagedVirtualNetwork",
);

const DEFAULT_NAME = "default";

const getManagedVirtualNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  managedVirtualNetworkName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetManagedVirtualNetwork({
      subscriptionId,
      resourceGroupName,
      factoryName,
      managedVirtualNetworkName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  name: string,
  observed: datafactory.GetManagedVirtualNetworkResponse,
): ManagedVirtualNetwork["Attributes"] => ({
  managedVirtualNetworkName: name,
  factoryName,
  resourceGroup,
  managedVirtualNetworkId: observed.id ?? "",
  vNetId: observed.properties.vNetId,
  alias: observed.properties.alias,
  etag: observed.etag,
});

export const ManagedVirtualNetworkProvider = () =>
  Provider.succeed(ManagedVirtualNetwork, {
    stables: [
      "managedVirtualNetworkName",
      "factoryName",
      "resourceGroup",
      "managedVirtualNetworkId",
      "vNetId",
      "alias",
    ],

    // Managed virtual networks live inside a factory and are reclaimed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.factoryName.toLowerCase() !== output.factoryName.toLowerCase() ||
        (news.name ?? DEFAULT_NAME).toLowerCase() !==
          output.managedVirtualNetworkName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const factoryName = output?.factoryName ?? olds?.factoryName;
      if (resourceGroup === undefined || factoryName === undefined) {
        return undefined;
      }
      const name =
        output?.managedVirtualNetworkName ?? olds?.name ?? DEFAULT_NAME;
      const observed = yield* getManagedVirtualNetwork(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, factoryName, name, observed);
      return (yield* factoryOwnedByStack(
        subscriptionId,
        resourceGroup,
        factoryName,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataFactory");
      const { resourceGroup, factoryName } = news;
      const name = news.name ?? DEFAULT_NAME;

      // Observe.
      let observed = yield* getManagedVirtualNetwork(
        subscriptionId,
        resourceGroup,
        factoryName,
        name,
      );

      // Ensure. Existence-only: there are no mutable properties to sync.
      if (observed === undefined) {
        observed = yield* datafactory.ManagedVirtualNetworksCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          factoryName,
          managedVirtualNetworkName: name,
          properties: {},
        });
      }

      return toAttrs(resourceGroup, factoryName, name, observed);
    }),

    // Data Factory has no delete API for managed virtual networks; Azure
    // reclaims them with the factory.
    delete: Effect.fn(function* () {}),

    nuke: { dependsOn: ["Azure.DataFactory.Factory"] },
  });
