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
  resourceGroupOf,
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
  sameJson,
  sameLocation,
  sameName,
} from "./DeviceRegistryShared.ts";

/** A messaging endpoint of a Device Registry namespace. */
export interface DeviceRegistryMessagingEndpoint {
  /** Type of connection used for the endpoint, e.g. `Microsoft.Devices/IoTHubs`. */
  endpointType?: string;
  /** The endpoint address to connect to. */
  address: string;
  /** ARM resource ID of the messaging endpoint (e.g. an IoT Hub). */
  resourceId?: string;
}

export interface NamespaceProps {
  /** Resource group the namespace is created in. Changing it replaces the namespace. */
  resourceGroup: string;
  /**
   * Namespace name: 3-63 lowercase letters, digits, and hyphens. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the namespace.
   */
  name?: string;
  /**
   * Azure location of the namespace. Changing it replaces the namespace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Enable a system-assigned managed identity.
   * @default Azure's default (no identity)
   */
  systemAssignedIdentity?: boolean;
  /**
   * Messaging endpoints keyed by endpoint name (e.g. an IoT Hub that
   * devices of the namespace connect to).
   * @default Azure's default (none)
   */
  messagingEndpoints?: Record<string, DeviceRegistryMessagingEndpoint>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Namespace extends Resource<
  "Azure.DeviceRegistry.Namespace",
  NamespaceProps,
  {
    /** Name of the namespace. */
    namespaceName: string;
    /** ARM resource ID of the namespace. */
    namespaceId: string;
    /** Resource group that holds the namespace. */
    resourceGroup: string;
    /** Location of the namespace. */
    location: string;
    /** Globally unique, immutable ID Azure assigns to the namespace. */
    uuid: string | undefined;
    /** Principal ID of the system-assigned identity, when enabled. */
    principalId: string | undefined;
    /** Messaging endpoints keyed by endpoint name. */
    messagingEndpoints: Record<string, DeviceRegistryMessagingEndpoint>;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Device Registry namespace — the container for devices and
 * assets managed through Azure Device Registry (used by Azure IoT
 * Operations and IoT Hub integration).
 *
 * @see https://learn.microsoft.com/azure/iot-operations/discover-manage-assets/overview-manage-assets
 *
 * ### Creating a Namespace
 * **Example:** Basic namespace
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("iot");
 * const ns = yield* Azure.DeviceRegistry.Namespace("devices", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Namespace with a managed identity
 * ```typescript
 * const ns = yield* Azure.DeviceRegistry.Namespace("devices", {
 *   resourceGroup: group.resourceGroupName,
 *   systemAssignedIdentity: true,
 *   tags: { env: "prod" },
 * });
 * ```
 *
 * @resource
 */
export const Namespace = Resource<Namespace>("Azure.DeviceRegistry.Namespace");

const getNamespace = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetNamespace({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    }),
  );

const observedEndpoints = (
  endpoints: deviceregistry.MessagingEndpointsMap | undefined,
): Record<string, DeviceRegistryMessagingEndpoint> =>
  Object.fromEntries(
    Object.entries(endpoints ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: deviceregistry.GetNamespaceResponse,
): Namespace["Attributes"] => ({
  namespaceName: name,
  namespaceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  uuid: observed.properties?.uuid,
  principalId: observed.identity?.principalId,
  messagingEndpoints: observedEndpoints(
    observed.properties?.messaging?.endpoints,
  ),
  tags: userTags(observed.tags),
});

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: [
      "namespaceName",
      "namespaceId",
      "resourceGroup",
      "location",
      "uuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        deviceregistry
          .ListNamespaceBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListNamespaceBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((ns) => {
        const group = resourceGroupOf(ns.id);
        return hasAnyAlchemyTag(ns.tags) &&
          group !== undefined &&
          ns.name !== undefined
          ? [toAttrs(group, ns.name, ns)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.namespaceName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location))
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
        output?.namespaceName ??
        olds?.name ??
        (yield* createDeviceRegistryName(id));
      const observed = yield* getNamespace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DEVICE_REGISTRY_RP);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.namespaceName ??
        (yield* createDeviceRegistryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity =
        news.systemAssignedIdentity === undefined
          ? undefined
          : {
              type: news.systemAssignedIdentity ? "SystemAssigned" : "None",
            };
      const messaging =
        news.messagingEndpoints === undefined
          ? undefined
          : { endpoints: news.messagingEndpoints };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName: name,
      };
      const get = getNamespace(subscriptionId, resourceGroup, name);
      const label = `device registry namespace ${name}`;
      const state = (ns: deviceregistry.GetNamespaceResponse) =>
        ns.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* deviceregistry.NamespacesCreateOrReplace({
          ...where,
          location,
          tags,
          identity,
          properties: messaging === undefined ? {} : { messaging },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        state,
        DEVICE_REGISTRY_WAIT,
      );

      // Sync identity, messaging endpoints, and tags against observed state.
      const identityChanged =
        identity !== undefined &&
        (observed.identity?.type ?? "None") !== identity.type;
      const messagingChanged =
        messaging !== undefined &&
        !sameJson(
          observedEndpoints(observed.properties?.messaging?.endpoints),
          messaging.endpoints,
        );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (identityChanged || messagingChanged || tagsChanged) {
        yield* deviceregistry.UpdateNamespace({
          ...where,
          identity: identityChanged ? identity : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: messagingChanged ? { messaging } : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          state,
          DEVICE_REGISTRY_WAIT,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteNamespace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
        }),
      );
      yield* waitUntilGone(
        `device registry namespace ${output.namespaceName}`,
        getNamespace(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
