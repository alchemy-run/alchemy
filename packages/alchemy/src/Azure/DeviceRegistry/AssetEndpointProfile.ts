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

/**
 * How connectors authenticate to the endpoint: `Anonymous`, `Certificate`
 * (an `x509Credentials.certificateSecretName`), or `UsernamePassword`
 * (`usernamePasswordCredentials` secret names). Values are names of
 * secrets on the IoT Operations cluster, not the secrets themselves.
 */
export type AssetEndpointProfileAuthentication = deviceregistry.Authentication;

export interface AssetEndpointProfileProps {
  /** Resource group the profile is created in. Changing it replaces the profile. */
  resourceGroup: string;
  /**
   * Profile name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the profile.
   */
  name?: string;
  /**
   * Azure location of the profile. Changing it replaces the profile.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Arc custom location (Azure IoT Operations) that hosts
   * the profile. Changing it replaces the profile.
   */
  customLocationId: string;
  /**
   * URI of the southbound device, e.g. `opc.tcp://plc.local:4840`. The
   * scheme identifies the device type.
   */
  targetAddress: string;
  /** Connector type that uses the profile, e.g. `Microsoft.OpcUa`. */
  endpointProfileType: string;
  /**
   * Client authentication to the device.
   * @default Azure's default (`Anonymous`)
   */
  authentication?: AssetEndpointProfileAuthentication;
  /** Stringified JSON with connector-specific configuration. */
  additionalConfiguration?: string;
  /**
   * Name of the discovered profile this profile was promoted from.
   * Changing it replaces the profile.
   */
  discoveredAssetEndpointProfileRef?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AssetEndpointProfile extends Resource<
  "Azure.DeviceRegistry.AssetEndpointProfile",
  AssetEndpointProfileProps,
  {
    /** Name of the profile. */
    assetEndpointProfileName: string;
    /** ARM resource ID of the profile. */
    assetEndpointProfileId: string;
    /** Resource group that holds the profile. */
    resourceGroup: string;
    /** Location of the profile. */
    location: string;
    /** ARM ID of the hosting custom location. */
    customLocationId: string;
    /** Globally unique, immutable ID Azure assigns to the profile. */
    uuid: string | undefined;
    /** URI of the southbound device. */
    targetAddress: string;
    /** Connector type that uses the profile. */
    endpointProfileType: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Device Registry asset endpoint profile (Azure IoT Operations
 * v1 model) — the connection information connectors use to reach a
 * southbound device. Superseded by namespace devices
 * (`Azure.DeviceRegistry.NamespaceDevice`).
 *
 * Requires an Arc-enabled Kubernetes cluster running Azure IoT Operations
 * (its custom location).
 *
 * @see https://learn.microsoft.com/azure/iot-operations/discover-manage-assets/overview-manage-assets
 *
 * ### Creating a Profile
 * **Example:** Anonymous OPC UA endpoint
 * ```typescript
 * const profile = yield* Azure.DeviceRegistry.AssetEndpointProfile("plc", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: aioCustomLocationId,
 *   targetAddress: "opc.tcp://plc.factory.local:4840",
 *   endpointProfileType: "Microsoft.OpcUa",
 *   authentication: { method: "Anonymous" },
 * });
 * ```
 *
 * **Example:** Username/password authentication
 * ```typescript
 * const profile = yield* Azure.DeviceRegistry.AssetEndpointProfile("plc", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: aioCustomLocationId,
 *   targetAddress: "opc.tcp://plc.factory.local:4840",
 *   endpointProfileType: "Microsoft.OpcUa",
 *   authentication: {
 *     method: "UsernamePassword",
 *     usernamePasswordCredentials: {
 *       usernameSecretName: "plc-username",
 *       passwordSecretName: "plc-password",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const AssetEndpointProfile = Resource<AssetEndpointProfile>(
  "Azure.DeviceRegistry.AssetEndpointProfile",
);

const getProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  assetEndpointProfileName: string,
) =>
  orUndefinedIfNotFound(
    deviceregistry.GetAssetEndpointProfile({
      subscriptionId,
      resourceGroupName,
      assetEndpointProfileName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: deviceregistry.GetAssetEndpointProfileResponse,
): AssetEndpointProfile["Attributes"] => ({
  assetEndpointProfileName: name,
  assetEndpointProfileId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  customLocationId: observed.extendedLocation.name,
  uuid: observed.properties?.uuid,
  targetAddress: observed.properties?.targetAddress ?? "",
  endpointProfileType: observed.properties?.endpointProfileType ?? "",
  tags: userTags(observed.tags),
});

export const AssetEndpointProfileProvider = () =>
  Provider.succeed(AssetEndpointProfile, {
    stables: [
      "assetEndpointProfileName",
      "assetEndpointProfileId",
      "resourceGroup",
      "location",
      "customLocationId",
      "uuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        deviceregistry
          .ListAssetEndpointProfileBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListAssetEndpointProfileBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((profile) => {
        const group = resourceGroupOf(profile.id);
        return hasAnyAlchemyTag(profile.tags) &&
          group !== undefined &&
          profile.name !== undefined
          ? [toAttrs(group, profile.name, profile)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.assetEndpointProfileName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        !sameName(news.customLocationId, output.customLocationId) ||
        (olds !== undefined &&
          news.discoveredAssetEndpointProfileRef !==
            olds.discoveredAssetEndpointProfileRef)
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
        output?.assetEndpointProfileName ??
        olds?.name ??
        (yield* createDeviceRegistryName(id));
      const observed = yield* getProfile(subscriptionId, resourceGroup, name);
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
        output?.assetEndpointProfileName ??
        (yield* createDeviceRegistryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        assetEndpointProfileName: name,
      };
      const get = getProfile(subscriptionId, resourceGroup, name);
      const label = `device registry asset endpoint profile ${name}`;
      const state = (p: deviceregistry.GetAssetEndpointProfileResponse) =>
        p.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* deviceregistry.AssetEndpointProfilesCreateOrReplace({
          ...where,
          location,
          tags,
          extendedLocation: {
            type: "CustomLocation",
            name: news.customLocationId,
          },
          properties: {
            targetAddress: news.targetAddress,
            endpointProfileType: news.endpointProfileType,
            authentication: news.authentication,
            additionalConfiguration: news.additionalConfiguration,
            discoveredAssetEndpointProfileRef:
              news.discoveredAssetEndpointProfileRef,
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
      const delta: deviceregistry.AssetEndpointProfileUpdateProperties = {};
      if (news.targetAddress !== props?.targetAddress) {
        delta.targetAddress = news.targetAddress;
      }
      if (news.endpointProfileType !== props?.endpointProfileType) {
        delta.endpointProfileType = news.endpointProfileType;
      }
      if (
        news.authentication !== undefined &&
        !sameJson(news.authentication, props?.authentication)
      ) {
        delta.authentication = news.authentication;
      }
      if (
        news.additionalConfiguration !== undefined &&
        news.additionalConfiguration !== props?.additionalConfiguration
      ) {
        delta.additionalConfiguration = news.additionalConfiguration;
      }
      const propsChanged = Object.keys(delta).length > 0;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* deviceregistry.UpdateAssetEndpointProfile({
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

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceregistry.DeleteAssetEndpointProfile({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          assetEndpointProfileName: output.assetEndpointProfileName,
        }),
      );
      yield* waitUntilGone(
        `device registry asset endpoint profile ${output.assetEndpointProfileName}`,
        getProfile(
          subscriptionId,
          output.resourceGroup,
          output.assetEndpointProfileName,
        ),
        DEVICE_REGISTRY_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
