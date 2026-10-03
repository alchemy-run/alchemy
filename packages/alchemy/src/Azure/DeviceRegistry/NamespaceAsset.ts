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
  changedKeys,
  createDeviceRegistryName,
  listOwnedNamespaces,
  sameJson,
  sameLocation,
  sameName,
} from "./DeviceRegistryShared.ts";

/** A dataset of a namespace asset (data points read from the device). */
export type NamespaceAssetDataset = deviceregistry.NamespaceDataset;
/** An event group of a namespace asset. */
export type NamespaceAssetEventGroup = deviceregistry.NamespaceEventGroup;
/** A stream of a namespace asset. */
export type NamespaceAssetStream = deviceregistry.NamespaceStream;
/** A management group (actions) of a namespace asset. */
export type NamespaceAssetManagementGroup = deviceregistry.ManagementGroup;
/** A default destination for asset datasets. */
export type NamespaceAssetDatasetDestination =
  deviceregistry.DatasetDestination;
/** A default destination for asset events. */
export type NamespaceAssetEventDestination = deviceregistry.EventDestination;
/** A default destination for asset streams. */
export type NamespaceAssetStreamDestination = deviceregistry.StreamDestination;

export interface NamespaceAssetProps {
  /** Resource group of the parent namespace. Changing it replaces the asset. */
  resourceGroup: string;
  /** Name of the parent Device Registry namespace. Changing it replaces the asset. */
  namespace: string;
  /**
   * Asset name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the asset.
   */
  name?: string;
  /**
   * Azure location of the asset. Changing it replaces the asset.
   * @default the parent namespace's location
   */
  location?: string;
  /**
   * ARM ID of the Arc custom location (Azure IoT Operations) that hosts
   * the asset. Changing it replaces the asset.
   */
  customLocationId: string;
  /** Name of the namespace device that provides data for this asset. Changing it replaces the asset. */
  device: string;
  /** Name of the endpoint on `device` to use. Changing it replaces the asset. */
  deviceEndpoint: string;
  /**
   * Asset ID provided by the customer. Changing it replaces the asset.
   * @default the asset's Azure-assigned UUID
   */
  externalAssetId?: string;
  /** Names of discovered assets this asset was promoted from. Changing it replaces the asset. */
  discoveredAssetRefs?: string[];
  /** Whether the asset is enabled. */
  enabled?: boolean;
  /** Human-readable display name. */
  displayName?: string;
  /** Human-readable description. */
  description?: string;
  /** Asset type definition URIs or IDs. */
  assetTypeRefs?: string[];
  /** Asset manufacturer. */
  manufacturer?: string;
  /** Asset manufacturer URI. */
  manufacturerUri?: string;
  /** Asset model. */
  model?: string;
  /** Asset product code. */
  productCode?: string;
  /** Hardware revision. */
  hardwareRevision?: string;
  /** Software revision. */
  softwareRevision?: string;
  /** Documentation URI. */
  documentationUri?: string;
  /** Serial number. */
  serialNumber?: string;
  /** Custom key-value attributes. */
  attributes?: Record<string, unknown>;
  /** Stringified JSON with connector-specific defaults for all datasets. */
  defaultDatasetsConfiguration?: string;
  /** Stringified JSON with connector-specific defaults for all events. */
  defaultEventsConfiguration?: string;
  /** Stringified JSON with connector-specific defaults for all streams. */
  defaultStreamsConfiguration?: string;
  /** Stringified JSON with connector-specific defaults for all management groups. */
  defaultManagementGroupsConfiguration?: string;
  /** Default destinations for datasets. */
  defaultDatasetsDestinations?: NamespaceAssetDatasetDestination[];
  /** Default destinations for events. */
  defaultEventsDestinations?: NamespaceAssetEventDestination[];
  /** Default destinations for streams. */
  defaultStreamsDestinations?: NamespaceAssetStreamDestination[];
  /** Datasets of the asset. */
  datasets?: NamespaceAssetDataset[];
  /** Event groups of the asset. */
  eventGroups?: NamespaceAssetEventGroup[];
  /** Streams of the asset. */
  streams?: NamespaceAssetStream[];
  /** Management groups of the asset. */
  managementGroups?: NamespaceAssetManagementGroup[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NamespaceAsset extends Resource<
  "Azure.DeviceRegistry.NamespaceAsset",
  NamespaceAssetProps,
  {
    /** Name of the asset. */
    assetName: string;
    /** ARM resource ID of the asset. */
    assetId: string;
    /** Name of the parent namespace. */
    namespaceName: string;
    /** Resource group that holds the parent namespace. */
    resourceGroup: string;
    /** Location of the asset. */
    location: string;
    /** ARM ID of the hosting custom location. */
    customLocationId: string;
    /** Name of the device that provides data for the asset. */
    device: string;
    /** Endpoint on the device used by the asset. */
    deviceEndpoint: string;
    /** Globally unique, immutable ID Azure assigns to the asset. */
    uuid: string | undefined;
    /** Customer-facing asset ID (defaults to the UUID). */
    externalAssetId: string | undefined;
    /** Counter incremented each time the asset is modified. */
    version: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An asset in an Azure Device Registry namespace — a logical
 * representation of equipment whose datasets, events, and streams Azure
 * IoT Operations connectors collect through a namespace device endpoint.
 *
 * Requires an Arc-enabled Kubernetes cluster running Azure IoT Operations
 * (its custom location).
 *
 * @see https://learn.microsoft.com/azure/iot-operations/discover-manage-assets/overview-manage-assets
 *
 * ### Creating an Asset
 * **Example:** OPC UA asset with one dataset
 * ```typescript
 * const asset = yield* Azure.DeviceRegistry.NamespaceAsset("oven", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   customLocationId: aioCustomLocationId,
 *   device: plc.deviceName,
 *   deviceEndpoint: "opcua",
 *   displayName: "Oven",
 *   datasets: [
 *     {
 *       name: "telemetry",
 *       dataPoints: [
 *         { name: "temperature", dataSource: "ns=3;s=Temperature" },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NamespaceAsset = Resource<NamespaceAsset>(
  "Azure.DeviceRegistry.NamespaceAsset",
);

/** Properties the PATCH API can change in place. */
const MUTABLE = [
  "enabled",
  "displayName",
  "description",
  "assetTypeRefs",
  "manufacturer",
  "manufacturerUri",
  "model",
  "productCode",
  "hardwareRevision",
  "softwareRevision",
  "documentationUri",
  "serialNumber",
  "attributes",
  "defaultDatasetsConfiguration",
  "defaultEventsConfiguration",
  "defaultStreamsConfiguration",
  "defaultManagementGroupsConfiguration",
  "defaultDatasetsDestinations",
  "defaultEventsDestinations",
  "defaultStreamsDestinations",
  "datasets",
  "eventGroups",
  "streams",
  "managementGroups",
] as const satisfies readonly (keyof NamespaceAssetProps &
  keyof deviceregistry.NamespaceAssetUpdateProperties)[];

const mutableOf = (
  props: NamespaceAssetProps,
): Pick<NamespaceAssetProps, (typeof MUTABLE)[number]> =>
  Object.fromEntries(MUTABLE.map((key) => [key, props[key]]));

const getAsset = (
  subscriptionId: string,
  resourceGroupName: string,
  namespaceName: string,
  assetName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetNamespaceAsset({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      assetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  namespaceName: string,
  name: string,
  observed: deviceregistry.GetNamespaceAssetResponse,
): NamespaceAsset["Attributes"] => ({
  assetName: name,
  assetId: observed.id ?? "",
  namespaceName,
  resourceGroup,
  location: observed.location,
  customLocationId: observed.extendedLocation.name,
  device: observed.properties?.deviceRef.deviceName ?? "",
  deviceEndpoint: observed.properties?.deviceRef.endpointName ?? "",
  uuid: observed.properties?.uuid,
  externalAssetId: observed.properties?.externalAssetId,
  version: observed.properties?.version,
  tags: userTags(observed.tags),
});

export const NamespaceAssetProvider = () =>
  Provider.succeed(NamespaceAsset, {
    stables: [
      "assetName",
      "assetId",
      "namespaceName",
      "resourceGroup",
      "location",
      "customLocationId",
      "uuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const namespaces = yield* listOwnedNamespaces(subscriptionId);
      const all: NamespaceAsset["Attributes"][] = [];
      for (const ns of namespaces) {
        const page = yield* orUndefinedIfNotFound(
          deviceregistry
            .ListNamespaceAssetByResourceGroup({
              subscriptionId,
              resourceGroupName: ns.resourceGroup,
              namespaceName: ns.name,
            })
            .pipe(
              Effect.flatMap((page) =>
                requireSinglePage("ListNamespaceAssetByResourceGroup", page),
              ),
            ),
        );
        for (const asset of page?.value ?? []) {
          if (hasAnyAlchemyTag(asset.tags) && asset.name !== undefined) {
            all.push(toAttrs(ns.resourceGroup, ns.name, asset.name, asset));
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
        (news.name !== undefined && !sameName(news.name, output.assetName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        !sameName(news.customLocationId, output.customLocationId) ||
        news.device !== output.device ||
        news.deviceEndpoint !== output.deviceEndpoint ||
        (news.externalAssetId !== undefined &&
          news.externalAssetId !== output.externalAssetId) ||
        (olds !== undefined &&
          !sameJson(news.discoveredAssetRefs, olds.discoveredAssetRefs))
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
        output?.assetName ??
        olds?.name ??
        (yield* createDeviceRegistryName(id));
      const observed = yield* getAsset(
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
        news.name ?? output?.assetName ?? (yield* createDeviceRegistryName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        namespaceName,
        assetName: name,
      };
      const get = getAsset(subscriptionId, resourceGroup, namespaceName, name);
      const label = `device registry asset ${namespaceName}/${name}`;
      const state = (a: deviceregistry.GetNamespaceAssetResponse) =>
        a.properties?.provisioningState;
      const desired = mutableOf(news);

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
        yield* deviceregistry.NamespaceAssetsCreateOrReplace({
          ...where,
          location,
          tags,
          extendedLocation: {
            type: "CustomLocation",
            name: news.customLocationId,
          },
          properties: {
            ...desired,
            deviceRef: {
              deviceName: news.device,
              endpointName: news.deviceEndpoint,
            },
            externalAssetId: news.externalAssetId,
            discoveredAssetRefs: news.discoveredAssetRefs,
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
      const changed = changedKeys(desired, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (changed.length > 0 || tagsChanged) {
        yield* deviceregistry.UpdateNamespaceAsset({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties:
            changed.length > 0
              ? Object.fromEntries(changed.map((key) => [key, desired[key]]))
              : undefined,
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
        deviceregistry.DeleteNamespaceAsset({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          namespaceName: output.namespaceName,
          assetName: output.assetName,
        }),
      );
      yield* waitUntilGone(
        `device registry asset ${output.namespaceName}/${output.assetName}`,
        getAsset(
          subscriptionId,
          output.resourceGroup,
          output.namespaceName,
          output.assetName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DeviceRegistry.Namespace",
        "Azure.DeviceRegistry.NamespaceDevice",
      ],
    },
  });
