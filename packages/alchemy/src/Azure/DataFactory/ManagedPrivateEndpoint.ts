import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { factoryOwnedByStack } from "./FactoryChild.ts";

export interface ManagedPrivateEndpointProps {
  /** Resource group of the factory. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** Name of the factory. Changing it replaces the endpoint. */
  factoryName: string;
  /**
   * Name of the factory's managed virtual network. Changing it replaces
   * the endpoint.
   * @default "default"
   */
  managedVirtualNetworkName?: string;
  /**
   * Endpoint name: letters, digits, `_`, and `-`. Data Factory names the
   * underlying private endpoint `<factoryName>.<name>`, which must fit in 80
   * characters. If omitted, a unique name that fits is generated from the
   * app, stage, and logical ID. Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * ARM resource ID of the target resource (storage account, SQL server,
   * key vault, ...). Changing it replaces the endpoint. Observed: targets in
   * very long resource group names (~90 characters) make provisioning end
   * in `Failed` with no actionable error.
   */
  privateLinkResourceId: string;
  /**
   * Sub-resource of the target to connect to, e.g. `blob`, `dfs`,
   * `sqlServer`, `vault`. Changing it replaces the endpoint.
   */
  groupId: string;
  /**
   * Fully qualified domain names served by the endpoint. Data Factory does
   * not update endpoints in place, so changing them replaces the endpoint.
   */
  fqdns?: string[];
}

export interface ManagedPrivateEndpoint extends Resource<
  "Azure.DataFactory.ManagedPrivateEndpoint",
  ManagedPrivateEndpointProps,
  {
    /** Name of the managed private endpoint. */
    managedPrivateEndpointName: string;
    /** Name of the managed virtual network that holds the endpoint. */
    managedVirtualNetworkName: string;
    /** Name of the factory. */
    factoryName: string;
    /** Resource group of the factory. */
    resourceGroup: string;
    /** ARM resource ID of the managed private endpoint. */
    managedPrivateEndpointId: string;
    /** ARM resource ID of the target resource. */
    privateLinkResourceId: string;
    /** Target sub-resource. */
    groupId: string;
    /** Provisioning state (`Succeeded` once ready). */
    provisioningState: string | undefined;
    /**
     * Approval status of the private endpoint connection on the target
     * (`Pending`, `Approved`, `Rejected`, `Disconnected`).
     */
    connectionStatus: string | undefined;
    /** Fully qualified domain names served by the endpoint. */
    fqdns: string[];
    /** Whether the endpoint is reserved by Data Factory. */
    isReserved: boolean | undefined;
  },
  never,
  Providers
> {}

/**
 * A managed private endpoint in a Data Factory managed virtual network.
 * It creates a private endpoint connection on the target resource that the
 * target's owner must approve (status `Pending` until then).
 *
 * @see https://learn.microsoft.com/azure/data-factory/managed-virtual-network-private-endpoint
 *
 * ### Connecting to Storage
 * **Example:** Private endpoint to a storage account's blob service
 * ```typescript
 * const vnet = yield* Azure.DataFactory.ManagedVirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 * });
 * const endpoint = yield* Azure.DataFactory.ManagedPrivateEndpoint("blob", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   managedVirtualNetworkName: vnet.managedVirtualNetworkName,
 *   privateLinkResourceId: account.storageAccountId,
 *   groupId: "blob",
 * });
 * ```
 *
 * ### Connecting to Other Services
 * **Example:** Private endpoint to an Azure SQL server
 * ```typescript
 * yield* Azure.DataFactory.ManagedPrivateEndpoint("sql", {
 *   resourceGroup: group.resourceGroupName,
 *   factoryName: factory.factoryName,
 *   managedVirtualNetworkName: vnet.managedVirtualNetworkName,
 *   privateLinkResourceId: server.serverId,
 *   groupId: "sqlServer",
 * });
 * ```
 *
 * @resource
 */
export const ManagedPrivateEndpoint = Resource<ManagedPrivateEndpoint>(
  "Azure.DataFactory.ManagedPrivateEndpoint",
);

const DEFAULT_VNET = "default";

/**
 * Data Factory names the underlying private endpoint
 * `<factoryName>.<endpointName>`, and private endpoint names are limited to
 * 80 characters; a longer combined name makes provisioning end in `Failed`.
 */
const createEndpointName = Effect.fn(function* (
  id: string,
  factoryName: string,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength: Math.max(8, Math.min(40, 79 - factoryName.length)),
    delimiter: "_",
  });
  return name.replace(/[^A-Za-z0-9_]/g, "_");
});

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  factoryName: string,
  managedVirtualNetworkName: string,
  managedPrivateEndpointName: string,
) =>
  orUndefinedIfNotFound(
    datafactory.GetManagedPrivateEndpoint({
      subscriptionId,
      resourceGroupName,
      factoryName,
      managedVirtualNetworkName,
      managedPrivateEndpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  factoryName: string,
  vnet: string,
  name: string,
  observed: datafactory.GetManagedPrivateEndpointResponse,
): ManagedPrivateEndpoint["Attributes"] => ({
  managedPrivateEndpointName: name,
  managedVirtualNetworkName: vnet,
  factoryName,
  resourceGroup,
  managedPrivateEndpointId: observed.id ?? "",
  privateLinkResourceId: observed.properties.privateLinkResourceId ?? "",
  groupId: observed.properties.groupId ?? "",
  provisioningState: observed.properties.provisioningState,
  connectionStatus: observed.properties.connectionState?.status,
  fqdns: [...(observed.properties.fqdns ?? [])],
  isReserved: observed.properties.isReserved,
});

const sortedLower = (values: ReadonlyArray<string> | undefined) =>
  (values ?? []).map((v) => v.toLowerCase()).sort();

const sameList = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const x = sortedLower(a);
  const y = sortedLower(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export const ManagedPrivateEndpointProvider = () =>
  Provider.succeed(ManagedPrivateEndpoint, {
    stables: [
      "managedPrivateEndpointName",
      "managedVirtualNetworkName",
      "factoryName",
      "resourceGroup",
      "managedPrivateEndpointId",
      "privateLinkResourceId",
      "groupId",
    ],

    // Endpoints live inside a factory; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.factoryName.toLowerCase() !== output.factoryName.toLowerCase() ||
        (news.managedVirtualNetworkName ?? DEFAULT_VNET).toLowerCase() !==
          output.managedVirtualNetworkName.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.managedPrivateEndpointName.toLowerCase()) ||
        news.privateLinkResourceId.toLowerCase() !==
          output.privateLinkResourceId.toLowerCase() ||
        news.groupId.toLowerCase() !== output.groupId.toLowerCase() ||
        (news.fqdns !== undefined && !sameList(news.fqdns, output.fqdns))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const factoryName = output?.factoryName ?? olds?.factoryName;
      if (resourceGroup === undefined || factoryName === undefined) {
        return undefined;
      }
      const vnet =
        output?.managedVirtualNetworkName ??
        olds?.managedVirtualNetworkName ??
        DEFAULT_VNET;
      const name =
        output?.managedPrivateEndpointName ??
        olds?.name ??
        (yield* createEndpointName(id, factoryName));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        factoryName,
        vnet,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, factoryName, vnet, name, observed);
      return (yield* factoryOwnedByStack(
        subscriptionId,
        resourceGroup,
        factoryName,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataFactory");
      const { resourceGroup, factoryName } = news;
      const vnet = news.managedVirtualNetworkName ?? DEFAULT_VNET;
      const name =
        news.name ??
        output?.managedPrivateEndpointName ??
        (yield* createEndpointName(id, factoryName));
      const get = getEndpoint(
        subscriptionId,
        resourceGroup,
        factoryName,
        vnet,
        name,
      );

      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        factoryName,
        managedVirtualNetworkName: vnet,
        managedPrivateEndpointName: name,
      };

      // Observe -> ensure -> wait. Every property is create-only (diff
      // replaces on change), so an existing endpoint only needs to finish
      // provisioning. Provisioning occasionally ends in `Failed` on a
      // fresh managed virtual network; a failed endpoint is deleted and
      // recreated (bounded).
      const ensure = Effect.gen(function* () {
        const observed = yield* get;
        if (observed?.properties.provisioningState === "Failed") {
          yield* ignoreNotFound(
            datafactory.DeleteManagedPrivateEndpoint(where),
          );
          yield* waitUntilGone(`managed private endpoint ${name}`, get, {
            interval: "10 seconds",
            times: 36,
          });
        }
        if (
          observed === undefined ||
          observed.properties.provisioningState === "Failed"
        ) {
          yield* datafactory.ManagedPrivateEndpointsCreateOrUpdate({
            ...where,
            properties: {
              privateLinkResourceId: news.privateLinkResourceId,
              groupId: news.groupId,
              fqdns: news.fqdns,
            },
          });
        }
        // Provisioning is asynchronous (Provisioning -> Succeeded).
        return yield* waitForProvisioned(
          `managed private endpoint ${name}`,
          get,
          (endpoint) => endpoint.properties.provisioningState,
          { interval: "10 seconds", times: 36 },
        );
      });
      const fresh = yield* ensure.pipe(
        Effect.retry({
          while: (e) => e._tag === "Azure.ProvisioningFailed",
          times: 1,
        }),
      );
      return toAttrs(resourceGroup, factoryName, vnet, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        factoryName: output.factoryName,
        managedVirtualNetworkName: output.managedVirtualNetworkName,
        managedPrivateEndpointName: output.managedPrivateEndpointName,
      };
      const get = orUndefinedIfNotFound(
        datafactory.GetManagedPrivateEndpoint(where),
      );
      // Data Factory rejects deleting an endpoint that is still
      // provisioning ("Invalid resource request"), so wait it out first.
      yield* get.pipe(
        Effect.repeat({
          until: (endpoint) =>
            endpoint?.properties.provisioningState !== "Provisioning",
          schedule: Schedule.spaced("10 seconds"),
          times: 36,
        }),
      );
      yield* ignoreNotFound(datafactory.DeleteManagedPrivateEndpoint(where));
      yield* waitUntilGone(
        `managed private endpoint ${output.managedPrivateEndpointName}`,
        get,
        { interval: "10 seconds", times: 36 },
      );
    }),

    nuke: { dependsOn: ["Azure.DataFactory.ManagedVirtualNetwork"] },
  });
