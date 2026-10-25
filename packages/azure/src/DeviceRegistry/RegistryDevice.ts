import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  DEVICE_REGISTRY_RP,
  DEVICE_REGISTRY_WAIT,
  createDeviceRegistryName,
  listOwnedNamespaces,
  sameLocation,
  sameName,
} from "./DeviceRegistryShared.ts";

export interface RegistryDeviceProps {
  /**
   * Resource group of the parent namespace. Changing it replaces the device.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the parent Device Registry namespace. Changing it replaces the device. */
  namespace: string;
  /**
   * Device name: 3-63 letters, digits, and hyphens, starting with a letter
   * or digit. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the device.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the device. Changing it replaces the device.
   * @default the parent namespace's location
   */
  location?: string;
  /**
   * Whether the device is enabled. A disabled device cannot send messages,
   * be updated, or reprovision.
   * @default true
   */
  enabled?: boolean;
  /**
   * Device ID provided by the customer. Changing it replaces the device.
   * @default Azure's default
   */
  externalDeviceId?: string;
  /**
   * Device manufacturer.
   * @default unset
   */
  manufacturer?: string;
  /**
   * Device model.
   * @default unset
   */
  model?: string;
  /**
   * Device hardware revision.
   * @default unset
   */
  hardwareRevision?: string;
  /**
   * Device software revision.
   * @default unset
   */
  softwareRevision?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default no user tags
   */
  tags?: Record<string, string>;
}

export interface RegistryDevice extends Resource<
  "Azure.DeviceRegistry.RegistryDevice",
  RegistryDeviceProps,
  {
    /** Name of the device. */
    registryDeviceName: string;
    /** ARM resource ID of the device. */
    registryDeviceId: string;
    /** Name of the parent namespace. */
    namespaceName: string;
    /** Resource group that holds the parent namespace. */
    resourceGroup: string;
    /** Location of the device. */
    location: string;
    /** Globally unique, immutable ID Azure assigns to the device. */
    uuid: string | undefined;
    /** Customer-provided device ID, if any. */
    externalDeviceId: string | undefined;
    /** Whether the device is enabled. */
    enabled: boolean;
    /** Device manufacturer. */
    manufacturer: string | undefined;
    /** Device model. */
    model: string | undefined;
    /** Device hardware revision. */
    hardwareRevision: string | undefined;
    /** Device software revision. */
    softwareRevision: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A registry device (`Microsoft.DeviceRegistry/namespaces/registryDevices`)
 * — the identity record of an IoT device in an Azure Device Registry
 * namespace, used by IoT Hub's Device Registry integration to provision and
 * authenticate the device.
 *
 * Registry devices are available only in `australiaeast`, `uksouth`,
 * `centralus`, and `japaneast`; create the parent namespace in one of them.
 *
 * @see https://learn.microsoft.com/azure/iot-hub/iot-hub-device-registry-overview
 *
 * :::caution
 * Changing `resourceGroup`, `namespace`, `name`, `location`, or
 * `externalDeviceId` replaces the device: Azure deletes the old device and
 * assigns the new one a new `uuid`.
 * :::
 *
 * ### Creating a Registry Device
 * **Example:** Enabled device
 * ```typescript
 * const ns = yield* Azure.DeviceRegistry.Namespace("devices");
 * const device = yield* Azure.DeviceRegistry.RegistryDevice("sensor", {
 *   namespace: ns.namespaceName,
 *   manufacturer: "Contoso",
 *   model: "S-100",
 * });
 * ```
 *
 * **Example:** Disabled device with a customer ID
 * ```typescript
 * const device = yield* Azure.DeviceRegistry.RegistryDevice("spare", {
 *   namespace: ns.namespaceName,
 *   externalDeviceId: "SN-0042",
 *   enabled: false,
 *   softwareRevision: "1.2.0",
 * });
 * ```
 *
 * @resource
 */
export const RegistryDevice = GroupedResource<RegistryDevice>(
  "Azure.DeviceRegistry.RegistryDevice",
);

const getDevice = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  registryDeviceName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetRegistryDevice({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      registryDeviceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespaceName: string,
  name: string,
  observed: deviceregistry.GetRegistryDeviceResponse,
): RegistryDevice["Attributes"] => ({
  registryDeviceName: name,
  registryDeviceId: observed.id ?? "",
  namespaceName,
  resourceGroup,
  location: observed.location,
  uuid: observed.properties?.uuid,
  externalDeviceId: observed.properties?.externalDeviceId,
  enabled: observed.properties?.enablementState !== "Disabled",
  manufacturer: observed.properties?.manufacturer,
  model: observed.properties?.model,
  hardwareRevision: observed.properties?.hardwareRevision,
  softwareRevision: observed.properties?.softwareRevision,
  tags: userTags(observed.tags),
});

const enablementState = (enabled: boolean | undefined) =>
  enabled === false ? ("Disabled" as const) : ("Enabled" as const);

export const RegistryDeviceProvider = () =>
  Provider.succeed(RegistryDevice, {
    stables: [
      "registryDeviceName",
      "registryDeviceId",
      "namespaceName",
      "resourceGroup",
      "location",
      "uuid",
      "externalDeviceId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const namespaces = yield* listOwnedNamespaces(subscriptionId);
      const all: RegistryDevice["Attributes"][] = [];
      for (const ns of namespaces) {
        const page = yield* orUndefinedIfNotFound(
          collectAll(deviceregistry.ListRegistryDeviceByNamespace, {
            subscriptionId,
            resourceGroupName: ns.resourceGroup,
            namespaceName: ns.name,
          }),
        );
        for (const device of page?.value ?? []) {
          if (hasAnyAlchemyTag(device.tags) && device.name !== undefined) {
            all.push(toAttrs(ns.resourceGroup, ns.name, device.name, device));
          }
        }
      }
      return all;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
        (news.name !== undefined && !sameName(news.name, output.registryDeviceName)) ||
        (news.location !== undefined && !sameLocation(news.location, output.location)) ||
        (news.externalDeviceId !== undefined && news.externalDeviceId !== output.externalDeviceId)
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
        output?.registryDeviceName ?? olds?.name ?? (yield* createDeviceRegistryName(id));
      const observed = yield* getDevice(subscriptionId, resourceGroup, namespaceName, name);
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
      const name = news.name ?? output?.registryDeviceName ?? (yield* createDeviceRegistryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName,
        registryDeviceName: name,
      };
      const get = getDevice(subscriptionId, resourceGroup, namespaceName, name);
      const label = `device registry registry device ${namespaceName}/${name}`;
      const state = (d: deviceregistry.GetRegistryDeviceResponse) =>
        d.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const namespace = yield* orUndefinedIfNotFound(
          deviceregistry.GetNamespace({
            subscriptionId,
            resourceGroupName: resourceGroup,
            namespaceName,
          }),
        );
        const location = news.location ?? output?.location ?? namespace?.location ?? env.location;
        yield* deviceregistry.RegistryDevicesCreateOrReplace({
          ...where,
          location,
          tags,
          properties: {
            enablementState: enablementState(news.enabled),
            externalDeviceId: news.externalDeviceId,
            manufacturer: news.manufacturer,
            model: news.model,
            hardwareRevision: news.hardwareRevision,
            softwareRevision: news.softwareRevision,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, state, DEVICE_REGISTRY_WAIT);

      // Sync mutable properties and tags against observed state.
      const props = observed.properties;
      const delta: deviceregistry.RegistryDeviceUpdateProperties = {};
      const desiredState = enablementState(news.enabled);
      if (desiredState !== props?.enablementState) delta.enablementState = desiredState;
      if (news.manufacturer !== undefined && news.manufacturer !== props?.manufacturer) {
        delta.manufacturer = news.manufacturer;
      }
      if (news.model !== undefined && news.model !== props?.model) {
        delta.model = news.model;
      }
      if (
        news.hardwareRevision !== undefined &&
        news.hardwareRevision !== props?.hardwareRevision
      ) {
        delta.hardwareRevision = news.hardwareRevision;
      }
      if (
        news.softwareRevision !== undefined &&
        news.softwareRevision !== props?.softwareRevision
      ) {
        delta.softwareRevision = news.softwareRevision;
      }
      const propsChanged = Object.keys(delta).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* deviceregistry.UpdateRegistryDevice({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: propsChanged ? delta : undefined,
        });
        observed = yield* waitForProvisioned(label, get, state, DEVICE_REGISTRY_WAIT);
      }

      return toAttrs(resourceGroup, namespaceName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteRegistryDevice({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
          registryDeviceName: output.registryDeviceName,
        }),
      );
      yield* waitUntilGone(
        `device registry registry device ${output.namespaceName}/${output.registryDeviceName}`,
        getDevice(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
          output.registryDeviceName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DeviceRegistry.Namespace"],
    },
  });
