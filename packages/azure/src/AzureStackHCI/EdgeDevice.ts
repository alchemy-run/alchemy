import * as hci from "@distilled.cloud/azure/azurestackhci";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { HCI_NAMESPACE, isMachineStackOwned, sameId, sameValue } from "./Common.ts";

export interface EdgeDeviceNic {
  /** Name of the network adapter. */
  adapterName: string;
  /**
   * Interface description of the adapter.
   * @default not set
   */
  interfaceDescription?: string;
  /**
   * Component ID of the adapter.
   * @default not set
   */
  componentId?: string;
  /**
   * Driver version of the adapter.
   * @default not set
   */
  driverVersion?: string;
  /**
   * IPv4 address of the adapter.
   * @default not set
   */
  ip4Address?: string;
  /**
   * Subnet mask of the adapter.
   * @default not set
   */
  subnetMask?: string;
  /**
   * Default gateway of the adapter.
   * @default not set
   */
  defaultGateway?: string;
  /**
   * DNS servers of the adapter.
   * @default none
   */
  dnsServers?: string[];
  /**
   * Default isolation (VLAN) ID of the management adapter.
   * @default not set
   */
  defaultIsolationId?: string;
}

export interface EdgeDeviceConfiguration {
  /**
   * Network adapters of the device.
   * @default none
   */
  nicDetails?: EdgeDeviceNic[];
  /**
   * Device metadata.
   * @default not set
   */
  deviceMetadata?: string;
}

export interface EdgeDeviceProps {
  /**
   * ARM ID of the Arc-enabled server (`Microsoft.HybridCompute/machines`)
   * the device extends. It must run a supported Azure Local OS. Changing it
   * replaces the device.
   */
  machineId: string;
  /**
   * Name of the edge device. Changing it replaces the device.
   * @default "default"
   */
  name?: string;
  /**
   * Network configuration of the device.
   * @default not set
   */
  deviceConfiguration?: EdgeDeviceConfiguration;
}

export interface EdgeDevice extends Resource<
  "Azure.AzureStackHCI.EdgeDevice",
  EdgeDeviceProps,
  {
    /** Name of the edge device. */
    edgeDeviceName: string;
    /** ARM ID of the Arc-enabled server the device extends. */
    machineId: string;
    /** ARM resource ID of the edge device. */
    edgeDeviceId: string;
    /** Kind of device (`HCI`). */
    kind: string;
    /** Provisioning state of the device. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Local edge device: the Azure Local view of an Arc-enabled
 * server that will become a cluster node, carrying its network adapter
 * configuration for deployment. The Arc machine must be a real Azure Local
 * node reporting a supported OS SKU.
 * The ARM type is `Microsoft.AzureStackHCI/edgeDevices`, an extension
 * resource on the Arc-enabled server.
 *
 * The device has no tags; Alchemy treats it as owned when its Arc machine
 * carries this stack's ownership tags.
 *
 * :::caution
 * Changing `machineId` or `name` replaces the device.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-local/deploy/deployment-arc-register-server-permissions
 *
 * ### Describing a Node
 * **Example:** Edge device with its management adapter
 * ```typescript
 * // ARM ID of the Arc-enabled server (Microsoft.HybridCompute/machines).
 * const arcServerId = yield* Config.string("ARC_SERVER_ID");
 * yield* Azure.AzureStackHCI.EdgeDevice("node-1", {
 *   machineId: arcServerId,
 *   deviceConfiguration: {
 *     nicDetails: [{ adapterName: "ethernet", ip4Address: "10.0.0.11" }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const EdgeDevice = Resource<EdgeDevice>("Azure.AzureStackHCI.EdgeDevice");

const getEdgeDevice = (resourceUri: string, edgeDeviceName: string) =>
  orUndefinedIfNotFound(hci.GetEdgeDevice({ resourceUri, edgeDeviceName }));

const toAttrs = (
  machineId: string,
  name: string,
  device: hci.GetEdgeDeviceResponse,
): EdgeDevice["Attributes"] => ({
  edgeDeviceName: name,
  machineId,
  edgeDeviceId: device.id ?? "",
  kind: device.kind,
  provisioningState: device.properties?.provisioningState,
});

export const EdgeDeviceProvider = () =>
  Provider.succeed(EdgeDevice, {
    stables: ["edgeDeviceName", "machineId", "edgeDeviceId"],

    // Edge devices are removed with their Arc machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.machineId, output.machineId) ||
        !sameId(news.name ?? "default", output.edgeDeviceName)
      ) {
        // The name is fixed per parent, so the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const machineId = output?.machineId ?? olds?.machineId;
      if (machineId === undefined) return undefined;
      const name = output?.edgeDeviceName ?? olds?.name ?? "default";
      const observed = yield* getEdgeDevice(machineId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(machineId, name, observed);
      return (yield* isMachineStackOwned(machineId)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { machineId } = news;
      const name = news.name ?? "default";
      const get = getEdgeDevice(machineId, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync the device configuration through the PUT upsert.
      if (
        observed === undefined ||
        (news.deviceConfiguration !== undefined &&
          !sameValue(news.deviceConfiguration, observed.properties?.deviceConfiguration))
      ) {
        yield* hci.EdgeDevicesCreateOrUpdate({
          resourceUri: machineId,
          edgeDeviceName: name,
          kind: "HCI",
          properties: { deviceConfiguration: news.deviceConfiguration },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge device ${name}`,
        get,
        (device) => device.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(machineId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        hci.DeleteEdgeDevice({
          resourceUri: output.machineId,
          edgeDeviceName: output.edgeDeviceName,
        }),
      );
      yield* waitUntilGone(
        `edge device ${output.edgeDeviceName}`,
        getEdgeDevice(output.machineId, output.edgeDeviceName),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
