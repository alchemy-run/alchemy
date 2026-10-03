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
  changedKeys,
  createDeviceRegistryName,
  sameJson,
  sameLocation,
  sameName,
} from "./DeviceRegistryShared.ts";

/** A dataset of an asset: named data points read from the device. */
export type AssetDataset = deviceregistry.Dataset;
/** An event of an asset. */
export type AssetEvent = deviceregistry.Event;
/** MQTT topic messages of an asset are published to. */
export type AssetTopic = deviceregistry.Topic;

export interface AssetProps {
  /** Resource group the asset is created in. Changing it replaces the asset. */
  resourceGroup: string;
  /**
   * Asset name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the asset.
   */
  name?: string;
  /**
   * Azure location of the asset. Changing it replaces the asset.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Arc custom location (Azure IoT Operations) that hosts
   * the asset. Changing it replaces the asset.
   */
  customLocationId: string;
  /**
   * Name of the asset endpoint profile that connects to the device.
   * Changing it replaces the asset.
   */
  assetEndpointProfile: string;
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
  /** Default MQTT topic for the asset's messages. */
  defaultTopic?: AssetTopic;
  /** Datasets of the asset. */
  datasets?: AssetDataset[];
  /** Events of the asset. */
  events?: AssetEvent[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Asset extends Resource<
  "Azure.DeviceRegistry.Asset",
  AssetProps,
  {
    /** Name of the asset. */
    assetName: string;
    /** ARM resource ID of the asset. */
    assetId: string;
    /** Resource group that holds the asset. */
    resourceGroup: string;
    /** Location of the asset. */
    location: string;
    /** ARM ID of the hosting custom location. */
    customLocationId: string;
    /** Name of the asset endpoint profile the asset uses. */
    assetEndpointProfile: string;
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
 * An Azure Device Registry asset (Azure IoT Operations v1 model) — a
 * piece of equipment whose datasets and events connectors collect through
 * an asset endpoint profile. Superseded by namespace assets
 * (`Azure.DeviceRegistry.NamespaceAsset`).
 *
 * Requires an Arc-enabled Kubernetes cluster running Azure IoT Operations
 * (its custom location).
 *
 * @see https://learn.microsoft.com/azure/iot-operations/discover-manage-assets/overview-manage-assets
 *
 * ### Creating an Asset
 * **Example:** OPC UA asset with a dataset
 * ```typescript
 * const profile = yield* Azure.DeviceRegistry.AssetEndpointProfile("plc", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: aioCustomLocationId,
 *   targetAddress: "opc.tcp://plc.factory.local:4840",
 *   endpointProfileType: "Microsoft.OpcUa",
 * });
 * const asset = yield* Azure.DeviceRegistry.Asset("oven", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: aioCustomLocationId,
 *   assetEndpointProfile: profile.assetEndpointProfileName,
 *   displayName: "Oven",
 *   defaultTopic: { path: "factory/oven", retain: "Never" },
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
export const Asset = Resource<Asset>("Azure.DeviceRegistry.Asset");

/** Properties the PATCH API can change in place. */
const MUTABLE = [
  "enabled",
  "displayName",
  "description",
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
  "defaultTopic",
  "datasets",
  "events",
] as const satisfies readonly (keyof AssetProps &
  keyof deviceregistry.AssetUpdateProperties)[];

const mutableOf = (
  props: AssetProps,
): Pick<AssetProps, (typeof MUTABLE)[number]> =>
  Object.fromEntries(MUTABLE.map((key) => [key, props[key]]));

const getAsset = (
  subscriptionId: string,
  resourceGroupName: string,
  assetName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetAsset({ subscriptionId, resourceGroupName, assetName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: deviceregistry.GetAssetResponse,
): Asset["Attributes"] => ({
  assetName: name,
  assetId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  customLocationId: observed.extendedLocation.name,
  assetEndpointProfile: observed.properties?.assetEndpointProfileRef ?? "",
  uuid: observed.properties?.uuid,
  externalAssetId: observed.properties?.externalAssetId,
  version: observed.properties?.version,
  tags: userTags(observed.tags),
});

export const AssetProvider = () =>
  Provider.succeed(Asset, {
    stables: [
      "assetName",
      "assetId",
      "resourceGroup",
      "location",
      "customLocationId",
      "uuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        deviceregistry
          .ListAssetBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListAssetBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((asset) => {
        const group = resourceGroupOf(asset.id);
        return hasAnyAlchemyTag(asset.tags) &&
          group !== undefined &&
          asset.name !== undefined
          ? [toAttrs(group, asset.name, asset)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.assetName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        !sameName(news.customLocationId, output.customLocationId) ||
        news.assetEndpointProfile !== output.assetEndpointProfile ||
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
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.assetName ??
        olds?.name ??
        (yield* createDeviceRegistryName(id));
      const observed = yield* getAsset(subscriptionId, resourceGroup, name);
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
        news.name ?? output?.assetName ?? (yield* createDeviceRegistryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        assetName: name,
      };
      const get = getAsset(subscriptionId, resourceGroup, name);
      const label = `device registry asset ${name}`;
      const state = (a: deviceregistry.GetAssetResponse) =>
        a.properties?.provisioningState;
      const desired = mutableOf(news);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* deviceregistry.AssetsCreateOrReplace({
          ...where,
          location,
          tags,
          extendedLocation: {
            type: "CustomLocation",
            name: news.customLocationId,
          },
          properties: {
            ...desired,
            assetEndpointProfileRef: news.assetEndpointProfile,
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
        yield* deviceregistry.UpdateAsset({
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

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteAsset({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          assetName: output.assetName,
        }),
      );
      yield* waitUntilGone(
        `device registry asset ${output.assetName}`,
        getAsset(subscriptionId, output.resourceGroup, output.assetName),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DeviceRegistry.AssetEndpointProfile",
      ],
    },
  });
