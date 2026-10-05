import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEVICE_REGISTRY_RP,
  DEVICE_REGISTRY_WAIT,
  createDeviceRegistryName,
  listOwnedNamespaces,
  sameJson,
  sameLocation,
  sameName,
} from "./DeviceRegistryShared.ts";

/**
 * Inbound and outbound endpoints of a device: `inbound` maps endpoint
 * names to the addresses Azure IoT Operations connectors use to reach the
 * device; `outbound.assigned` maps endpoint names to destinations the
 * device sends to.
 */
export type NamespaceDeviceEndpoints = deviceregistry.MessagingEndpoints;

export interface NamespaceDeviceProps {
  /** Resource group of the parent namespace. Changing it replaces the device. */
  resourceGroup: string;
  /** Name of the parent Device Registry namespace. Changing it replaces the device. */
  namespace: string;
  /**
   * Device name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the device.
   */
  name?: string;
  /**
   * Azure location of the device. Changing it replaces the device.
   * @default the parent namespace's location
   */
  location?: string;
  /**
   * ARM ID of an Arc custom location (Azure IoT Operations) that hosts the
   * device. Omit for a cloud-only device. Changing it replaces the device.
   * @default none (cloud-only device)
   */
  customLocationId?: string;
  /**
   * Device ID provided by the customer. Changing it replaces the device.
   * @default the device's Azure-assigned UUID
   */
  externalDeviceId?: string;
  /**
   * Name of the discovered device this device was promoted from. Changing
   * it replaces the device.
   */
  discoveredDeviceRef?: string;
  /**
   * Whether the device is enabled.
   * @default Azure's default (`false`)
   */
  enabled?: boolean;
  /** Device manufacturer. Changing it replaces the device. */
  manufacturer?: string;
  /** Device model. Changing it replaces the device. */
  model?: string;
  /** Device operating system. Changing it replaces the device. */
  operatingSystem?: string;
  /** Device operating system version. */
  operatingSystemVersion?: string;
  /** Inbound and outbound endpoints of the device. */
  endpoints?: NamespaceDeviceEndpoints;
  /** Custom key-value attributes of the device. */
  attributes?: Record<string, unknown>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NamespaceDevice extends Resource<
  "Azure.DeviceRegistry.NamespaceDevice",
  NamespaceDeviceProps,
  {
    /** Name of the device. */
    deviceName: string;
    /** ARM resource ID of the device. */
    deviceId: string;
    /** Name of the parent namespace. */
    namespaceName: string;
    /** Resource group that holds the parent namespace. */
    resourceGroup: string;
    /** Location of the device. */
    location: string;
    /** ARM ID of the hosting custom location, if any. */
    customLocationId: string | undefined;
    /** Globally unique, immutable ID Azure assigns to the device. */
    uuid: string | undefined;
    /** Customer-facing device ID (defaults to the UUID). */
    externalDeviceId: string | undefined;
    /** Counter incremented each time the device is modified. */
    version: number | undefined;
    /** Whether the device is enabled. */
    enabled: boolean | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A device in an Azure Device Registry namespace — the cloud
 * representation of a physical or logical device that Azure IoT
 * Operations connectors (or IoT Hub) talk to.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/discover-manage-assets/overview-manage-assets
 *
 * ### Creating a Device
 * **Example:** Cloud-only device
 * ```typescript
 * const ns = yield* Azure.DeviceRegistry.Namespace("devices", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const device = yield* Azure.DeviceRegistry.NamespaceDevice("thermostat", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   manufacturer: "Contoso",
 *   model: "T-1000",
 *   enabled: true,
 * });
 * ```
 *
 * ### Edge Devices
 * **Example:** Device with an OPC UA endpoint on an IoT Operations cluster
 * ```typescript
 * const device = yield* Azure.DeviceRegistry.NamespaceDevice("plc", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   customLocationId: aioCustomLocationId,
 *   endpoints: {
 *     inbound: {
 *       opcua: {
 *         endpointType: "Microsoft.OpcUa",
 *         address: "opc.tcp://plc.factory.local:4840",
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const NamespaceDevice = Resource<NamespaceDevice>(
  "Azure.DeviceRegistry.NamespaceDevice",
);

const getDevice = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  deviceName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetNamespaceDevice({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      deviceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespaceName: string,
  name: string,
  observed: deviceregistry.GetNamespaceDeviceResponse,
): NamespaceDevice["Attributes"] => ({
  deviceName: name,
  deviceId: observed.id ?? "",
  namespaceName,
  resourceGroup,
  location: observed.location,
  customLocationId: observed.extendedLocation?.name,
  uuid: observed.properties?.uuid,
  externalDeviceId: observed.properties?.externalDeviceId,
  version: observed.properties?.version,
  enabled: observed.properties?.enabled,
  tags: userTags(observed.tags),
});

/** Device properties the PATCH API cannot change (set at creation only). */
const CREATE_ONLY = [
  "discoveredDeviceRef",
  "manufacturer",
  "model",
  "operatingSystem",
] as const;

export const NamespaceDeviceProvider = () =>
  Provider.succeed(NamespaceDevice, {
    stables: [
      "deviceName",
      "deviceId",
      "namespaceName",
      "resourceGroup",
      "location",
      "uuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const namespaces = yield* listOwnedNamespaces(subscriptionId);
      const all: NamespaceDevice["Attributes"][] = [];
      for (const ns of namespaces) {
        const page = yield* orUndefinedIfNotFound(
          deviceregistry
            .ListNamespaceDeviceByResourceGroup({
              subscriptionId,
              resourceGroupName: ns.resourceGroup,
              namespaceName: ns.name,
            })
            .pipe(
              Effect.flatMap((page) =>
                requireSinglePage("ListNamespaceDeviceByResourceGroup", page),
              ),
            ),
        );
        for (const device of page?.value ?? []) {
          if (hasAnyAlchemyTag(device.tags) && device.name !== undefined) {
            all.push(toAttrs(ns.resourceGroup, ns.name, device.name, device));
          }
        }
      }
      return all;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined && !sameName(news.name, output.deviceName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        !sameName(news.customLocationId, output.customLocationId) ||
        (news.externalDeviceId !== undefined &&
          news.externalDeviceId !== output.externalDeviceId) ||
        (olds !== undefined &&
          CREATE_ONLY.some((key) => news[key] !== olds[key]))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      if (resourceGroup === undefined || namespaceName === undefined) {
        return undefined;
      }
      const name =
        output?.deviceName ??
        olds?.name ??
        (yield* createDeviceRegistryName(id));
      const observed = yield* getDevice(
        subscriptionId,
        resourceGroup,
        namespaceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, namespaceName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DEVICE_REGISTRY_RP);
      const resourceGroup = news.resourceGroup;
      const namespaceName = news.namespace;
      const name =
        news.name ??
        output?.deviceName ??
        (yield* createDeviceRegistryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName,
        deviceName: name,
      };
      const get = getDevice(subscriptionId, resourceGroup, namespaceName, name);
      const label = `device registry device ${namespaceName}/${name}`;
      const state = (d: deviceregistry.GetNamespaceDeviceResponse) =>
        d.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* orUndefinedIfNotFound(
            deviceregistry.GetNamespace({
              subscriptionId,
              resourceGroupName: resourceGroup,
              namespaceName,
            }),
          ))?.location ??
          env.location;
        yield* deviceregistry.NamespaceDevicesCreateOrReplace({
          ...where,
          location,
          tags,
          extendedLocation:
            news.customLocationId === undefined
              ? undefined
              : { type: "CustomLocation", name: news.customLocationId },
          properties: {
            enabled: news.enabled,
            externalDeviceId: news.externalDeviceId,
            discoveredDeviceRef: news.discoveredDeviceRef,
            manufacturer: news.manufacturer,
            model: news.model,
            operatingSystem: news.operatingSystem,
            operatingSystemVersion: news.operatingSystemVersion,
            endpoints: news.endpoints,
            attributes: news.attributes,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        state,
        DEVICE_REGISTRY_WAIT,
      );

      // Sync mutable properties and tags against observed state.
      const props = observed.properties;
      const delta: deviceregistry.NamespaceDeviceUpdateProperties = {};
      if (news.enabled !== undefined && news.enabled !== props?.enabled) {
        delta.enabled = news.enabled;
      }
      if (
        news.operatingSystemVersion !== undefined &&
        news.operatingSystemVersion !== props?.operatingSystemVersion
      ) {
        delta.operatingSystemVersion = news.operatingSystemVersion;
      }
      if (
        news.endpoints !== undefined &&
        !sameJson(news.endpoints, props?.endpoints)
      ) {
        delta.endpoints = news.endpoints;
      }
      if (
        news.attributes !== undefined &&
        !sameJson(news.attributes, props?.attributes)
      ) {
        delta.attributes = news.attributes;
      }
      const propsChanged = Object.keys(delta).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* deviceregistry.UpdateNamespaceDevice({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: propsChanged ? delta : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          state,
          DEVICE_REGISTRY_WAIT,
        );
      }

      return toAttrs(resourceGroup, namespaceName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteNamespaceDevice({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
          deviceName: output.deviceName,
        }),
      );
      yield* waitUntilGone(
        `device registry device ${output.namespaceName}/${output.deviceName}`,
        getDevice(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
          output.deviceName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DeviceRegistry.Namespace",
      ],
    },
  });
