import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createFabricName,
  differs,
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface NetworkFabricProps {
  /**
   * Resource group the network fabric is created in. Changing it replaces the
   * network fabric.
   */
  resourceGroup: string;
  /**
   * Name of the network fabric. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the network fabric.
   */
  name?: string;
  /**
   * Azure location of the network fabric. Changing it replaces the network fabric.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the managing Network Fabric Controller. Changing it
   * replaces the fabric.
   */
  networkFabricControllerId: string;
  /**
   * Fabric SKU, e.g. `M4-A400-A100-C16-aa`. Changing it replaces the
   * fabric.
   */
  networkFabricSku: string;
  /**
   * Fabric software version, e.g. `5.0.0`. Changing it replaces the fabric
   * (use the upgrade action for in-place upgrades).
   */
  fabricVersion: string;
  /** Number of storage arrays. Changing it replaces the fabric. */
  storageArrayCount?: number;
  /** Number of compute servers per rack. */
  serverCountPerRack: number;
  /** Number of compute racks (1-8). */
  rackCount: number;
  /** IPv4 prefix for the fabric's management network, e.g. `10.18.0.0/19`. */
  ipv4Prefix: string;
  /** IPv6 prefix for the fabric's management network. */
  ipv6Prefix?: string;
  /** BGP autonomous system number of the fabric. */
  fabricASN: number;
  /**
   * Terminal server credentials and addressing. The password is not
   * returned by Azure, so changes are detected against the previous props.
   */
  terminalServerConfiguration: mnf.NetworkFabricPropertiesInput["terminalServerConfiguration"];
  /** Infrastructure and workload management VPN configuration. */
  managementNetworkConfiguration: mnf.NetworkFabricPropertiesInput["managementNetworkConfiguration"];
  /** Storage account the fabric writes device logs and configuration to. */
  storageAccountConfiguration?: mnf.NetworkFabricPropertiesInput["storageAccountConfiguration"];
  /** Hardware alert threshold percentage. */
  hardwareAlertThreshold?: number;
  /** ARM IDs of control-plane ACLs applied to the fabric. */
  controlPlaneAcls?: mnf.NetworkFabricPropertiesInput["controlPlaneAcls"];
  /** Fabric feature flags. */
  featureFlags?: mnf.NetworkFabricPropertiesInput["featureFlags"];
  /** ARM IDs of trusted IP prefix lists. */
  trustedIpPrefixes?: mnf.NetworkFabricPropertiesInput["trustedIpPrefixes"];
  /** Unique route distinguisher configuration. */
  uniqueRdConfiguration?: mnf.NetworkFabricPropertiesInput["uniqueRdConfiguration"];
  /** Authorized transceiver key configuration. */
  authorizedTransceiver?: mnf.NetworkFabricPropertiesInput["authorizedTransceiver"];
  /** Quality-of-service configuration. */
  qosConfiguration?: mnf.NetworkFabricPropertiesInput["qosConfiguration"];
  /** Free-form description. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkFabric extends Resource<
  "Azure.ManagedNetworkFabric.NetworkFabric",
  NetworkFabricProps,
  {
    /** Name of the network fabric. */
    networkFabricName: string;
    /** ARM resource ID of the network fabric. */
    networkFabricId: string;
    /** Resource group that holds the network fabric. */
    resourceGroup: string;
    /** Location of the network fabric. */
    location: string;
    /** Network racks of the fabric. */
    racks: string[];
    /** L2 isolation domains on the fabric. */
    l2IsolationDomains: string[];
    /** L3 isolation domains on the fabric. */
    l3IsolationDomains: string[];
    /** Description of the network fabric. */
    annotation: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** Administrative state, e.g. `Enabled` or `Disabled`. */
    administrativeState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus Network Fabric — the on-premises switching fabric
 * (racks of Arista CE/ToR/management switches, terminal server, packet
 * brokers) managed by a Network Fabric Controller. Creating the resource
 * records the fabric's design; the hardware is brought up with the provision
 * action. Needs Operator Nexus hardware.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-network-fabric
 *
 * ### Creating a Network Fabric
 * **Example:** Fabric managed by a controller
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const fabric = yield* Azure.ManagedNetworkFabric.NetworkFabric("fab1", {
 *   resourceGroup: group.resourceGroupName,
 *   networkFabricControllerId: nfc.networkFabricControllerId,
 *   networkFabricSku: "M4-A400-A100-C16-aa",
 *   fabricVersion: "5.0.0",
 *   rackCount: 4,
 *   serverCountPerRack: 8,
 *   ipv4Prefix: "10.18.0.0/19",
 *   fabricASN: 65048,
 *   terminalServerConfiguration: {
 *     username: "admin",
 *     password: Redacted.make(terminalServerPassword),
 *     primaryIpv4Prefix: "10.0.0.12/30",
 *     secondaryIpv4Prefix: "20.0.0.12/30",
 *   },
 *   managementNetworkConfiguration: {
 *     infrastructureVpnConfiguration: { peeringOption: "OptionB", optionBProperties: { importRouteTargets: ["65048:1"], exportRouteTargets: ["65048:1"] } },
 *     workloadVpnConfiguration: { peeringOption: "OptionB", optionBProperties: { importRouteTargets: ["65048:2"], exportRouteTargets: ["65048:2"] } },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const NetworkFabric = Resource<NetworkFabric>(
  "Azure.ManagedNetworkFabric.NetworkFabric",
);

type Observed = mnf.GetNetworkFabricResponse;

const getNetworkFabric = (
  subscriptionId: string,
  resourceGroupName: string,
  networkFabricName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetNetworkFabric({
      subscriptionId,
      resourceGroupName,
      networkFabricName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): NetworkFabric["Attributes"] => {
  const p = observed.properties;
  return {
    networkFabricName: name,
    networkFabricId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    racks: [...(p?.racks ?? [])],
    l2IsolationDomains: [...(p?.l2IsolationDomains ?? [])],
    l3IsolationDomains: [...(p?.l3IsolationDomains ?? [])],
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const NetworkFabricProvider = () =>
  Provider.succeed(NetworkFabric, {
    stables: [
      "networkFabricName",
      "networkFabricId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListNetworkFabricBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkFabricBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.networkFabricName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (!sameArm(
            news.networkFabricControllerId,
            olds.networkFabricControllerId,
          ) ||
            differs(news.networkFabricSku, olds.networkFabricSku) ||
            differs(news.fabricVersion, olds.fabricVersion) ||
            differs(news.storageArrayCount, olds.storageArrayCount)))
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
        output?.networkFabricName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getNetworkFabric(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, olds }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.networkFabricName ?? (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkFabricName: name,
      };
      const label = `network fabric ${name}`;
      const get = getNetworkFabric(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateNetworkFabric({
          ...where,
          location,
          tags,
          properties: {
            networkFabricControllerId: news.networkFabricControllerId,
            networkFabricSku: news.networkFabricSku,
            fabricVersion: news.fabricVersion,
            storageArrayCount: news.storageArrayCount,
            serverCountPerRack: news.serverCountPerRack,
            rackCount: news.rackCount,
            ipv4Prefix: news.ipv4Prefix,
            ipv6Prefix: news.ipv6Prefix,
            fabricASN: news.fabricASN,
            terminalServerConfiguration: news.terminalServerConfiguration,
            managementNetworkConfiguration: news.managementNetworkConfiguration,
            storageAccountConfiguration: news.storageAccountConfiguration,
            hardwareAlertThreshold: news.hardwareAlertThreshold,
            controlPlaneAcls: news.controlPlaneAcls,
            featureFlags: news.featureFlags,
            trustedIpPrefixes: news.trustedIpPrefixes,
            uniqueRdConfiguration: news.uniqueRdConfiguration,
            authorizedTransceiver: news.authorizedTransceiver,
            qosConfiguration: news.qosConfiguration,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        serverCountPerRack: news.serverCountPerRack,
        rackCount: news.rackCount,
        ipv4Prefix: news.ipv4Prefix,
        ipv6Prefix: news.ipv6Prefix,
        fabricASN: news.fabricASN,
        managementNetworkConfiguration: news.managementNetworkConfiguration,
        storageAccountConfiguration: news.storageAccountConfiguration,
        hardwareAlertThreshold: news.hardwareAlertThreshold,
        controlPlaneAcls: news.controlPlaneAcls,
        featureFlags: news.featureFlags,
        trustedIpPrefixes: news.trustedIpPrefixes,
        uniqueRdConfiguration: news.uniqueRdConfiguration,
        authorizedTransceiver: news.authorizedTransceiver,
        qosConfiguration: news.qosConfiguration,
        annotation: news.annotation,
      });
      // Secrets are not returned by GET: compare against the last props
      // (sent on create; not observable after adoption).
      const secretDelta = {
        terminalServerConfiguration:
          olds !== undefined &&
          differs(
            news.terminalServerConfiguration,
            olds.terminalServerConfiguration,
          )
            ? news.terminalServerConfiguration
            : undefined,
      };
      const secretsChanged = Object.values(secretDelta).some(
        (value) => value !== undefined,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || secretsChanged || tagsChanged) {
        yield* mnf.UpdateNetworkFabric({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: { ...delta, ...(secretsChanged ? secretDelta : {}) },
        });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        networkFabricName: output.networkFabricName,
      };
      const label = `network fabric ${output.networkFabricName}`;
      const get = getNetworkFabric(
        subscriptionId,
        output.resourceGroup,
        output.networkFabricName,
      );
      // A provisioned fabric must be deprovisioned before it can be deleted.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.NetworkFabricsDeprovision(where);
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteNetworkFabric(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ManagedNetworkFabric.NetworkFabricController",
      ],
    },
  });
