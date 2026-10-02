import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createNetworkName,
  parentOwned,
  sameId,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileNetworkBusy,
} from "./common.ts";

export interface PrivateDnsZoneConfigSpec {
  /**
   * Name of the configuration, unique within the group.
   * @default the last segment of the zone name with `.` replaced by `-`
   */
  name?: string;
  /**
   * ARM ID of the private DNS zone, e.g. the ID of
   * `privatelink.blob.core.windows.net`.
   */
  privateDnsZoneId: string;
}

export interface PrivateDnsZoneGroupProps {
  /**
   * Resource group of the private endpoint. Changing it replaces the group.
   */
  resourceGroup: string;
  /** Name of the parent private endpoint. Changing it replaces the group. */
  privateEndpoint: string;
  /**
   * Name of the zone group: 1-80 letters, digits, `_`, `.`, and `-`. A
   * private endpoint holds at most one zone group. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the group.
   */
  name?: string;
  /**
   * Private DNS zones Azure keeps the endpoint's A records in (one per
   * target sub-resource, up to 5).
   */
  privateDnsZoneConfigs: PrivateDnsZoneConfigSpec[];
}

export interface PrivateDnsZoneGroupRecordSet {
  /** Record type, e.g. `A`. */
  recordType: string | undefined;
  /** Record name relative to the zone. */
  recordSetName: string | undefined;
  /** Fully-qualified name that resolves to the endpoint. */
  fqdn: string | undefined;
  /** Private IP addresses of the endpoint. */
  ipAddresses: string[];
}

export interface PrivateDnsZoneGroup extends Resource<
  "Azure.Network.PrivateDnsZoneGroup",
  PrivateDnsZoneGroupProps,
  {
    /** Name of the zone group. */
    privateDnsZoneGroupName: string;
    /** ARM resource ID of the zone group. */
    privateDnsZoneGroupId: string;
    /** Name of the parent private endpoint. */
    privateEndpoint: string;
    /** Resource group of the private endpoint. */
    resourceGroup: string;
    /** IDs of the private DNS zones in the group. */
    privateDnsZoneIds: string[];
    /** DNS records Azure registered for the endpoint. */
    recordSets: PrivateDnsZoneGroupRecordSet[];
  },
  never,
  Providers
> {}

/**
 * A private DNS zone group of an Azure private endpoint. Azure registers
 * (and removes) the endpoint's A records in the listed private DNS zones,
 * so names like `<account>.blob.core.windows.net` resolve to the private
 * IP from networks linked to the zone.
 *
 * Zone groups carry no tags: ownership follows the parent private
 * endpoint.
 *
 * @see https://learn.microsoft.com/azure/private-link/private-endpoint-dns-integration
 *
 * ### Registering a Private Endpoint in DNS
 * **Example:** Blob endpoint with a private DNS zone
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("files-blob", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: account.storageAccountId, groupIds: ["blob"] },
 *   ],
 * });
 * yield* Azure.Network.PrivateDnsZoneGroup("files-blob-dns", {
 *   resourceGroup: group.resourceGroupName,
 *   privateEndpoint: endpoint.privateEndpointName,
 *   privateDnsZoneConfigs: [{ privateDnsZoneId: blobZoneId }],
 * });
 * ```
 *
 * @resource
 */
export const PrivateDnsZoneGroup = Resource<PrivateDnsZoneGroup>(
  "Azure.Network.PrivateDnsZoneGroup",
);

type Observed = network.GetPrivateDnsZoneGroupResponse;

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  privateEndpointName: string,
  privateDnsZoneGroupName: string,
) =>
  orUndefinedIfNotFound(
    network.GetPrivateDnsZoneGroup({
      subscriptionId,
      resourceGroupName,
      privateEndpointName,
      privateDnsZoneGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  privateEndpoint: string,
  name: string,
  group: Observed,
): PrivateDnsZoneGroup["Attributes"] => {
  const configs = group.properties?.privateDnsZoneConfigs ?? [];
  return {
    privateDnsZoneGroupName: name,
    privateDnsZoneGroupId: group.id ?? "",
    privateEndpoint,
    resourceGroup,
    privateDnsZoneIds: configs.flatMap((config) =>
      config.properties?.privateDnsZoneId
        ? [config.properties.privateDnsZoneId]
        : [],
    ),
    recordSets: configs.flatMap((config) =>
      (config.properties?.recordSets ?? []).map((record) => ({
        recordType: record.recordType,
        recordSetName: record.recordSetName,
        fqdn: record.fqdn,
        ipAddresses: [...(record.ipAddresses ?? [])],
      })),
    ),
  };
};

const configName = (config: PrivateDnsZoneConfigSpec) =>
  config.name ??
  (config.privateDnsZoneId.split("/").pop() ?? "zone").replaceAll(".", "-");

export const PrivateDnsZoneGroupProvider = () =>
  Provider.succeed(PrivateDnsZoneGroup, {
    stables: [
      "privateDnsZoneGroupName",
      "privateDnsZoneGroupId",
      "privateEndpoint",
      "resourceGroup",
    ],

    // Zone groups live inside a private endpoint; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.privateEndpoint, output.privateEndpoint) ||
        (news.name !== undefined &&
          !sameId(news.name, output.privateDnsZoneGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateEndpoint = output?.privateEndpoint ?? olds?.privateEndpoint;
      if (resourceGroup === undefined || privateEndpoint === undefined) {
        return undefined;
      }
      const name =
        output?.privateDnsZoneGroupName ??
        olds?.name ??
        (yield* createNetworkName(id));
      const observed = yield* getGroup(
        subscriptionId,
        resourceGroup,
        privateEndpoint,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, privateEndpoint, name, observed);
      const endpoint = yield* orUndefinedIfNotFound(
        network.GetPrivateEndpoint({
          subscriptionId,
          resourceGroupName: resourceGroup,
          privateEndpointName: privateEndpoint,
        }),
      );
      return (yield* parentOwned(endpoint?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, privateEndpoint } = news;
      const name =
        news.name ??
        output?.privateDnsZoneGroupName ??
        (yield* createNetworkName(id));
      const get = getGroup(
        subscriptionId,
        resourceGroup,
        privateEndpoint,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync the zone configurations (one PUT on drift).
      const desired = news.privateDnsZoneConfigs.map((config) => ({
        name: configName(config),
        properties: { privateDnsZoneId: config.privateDnsZoneId },
      }));
      const normalize = (
        configs: ReadonlyArray<{
          name?: string;
          properties?: { privateDnsZoneId?: string };
        }>,
      ) =>
        canonical(
          configs
            .map((config) => ({
              name: config.name?.toLowerCase(),
              zone: config.properties?.privateDnsZoneId?.toLowerCase(),
            }))
            .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
        );
      if (
        observed === undefined ||
        normalize(observed.properties?.privateDnsZoneConfigs ?? []) !==
          normalize(desired)
      ) {
        yield* network
          .PrivateDnsZoneGroupsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            privateEndpointName: privateEndpoint,
            privateDnsZoneGroupName: name,
            properties: { privateDnsZoneConfigs: desired },
          })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(
        `private DNS zone group ${privateEndpoint}/${name}`,
        get,
      );
      return toAttrs(resourceGroup, privateEndpoint, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeletePrivateDnsZoneGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateEndpointName: output.privateEndpoint,
          privateDnsZoneGroupName: output.privateDnsZoneGroupName,
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGone(
        `private DNS zone group ${output.privateEndpoint}/${output.privateDnsZoneGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.privateEndpoint,
          output.privateDnsZoneGroupName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Network.PrivateEndpoint",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
