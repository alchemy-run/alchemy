import * as network from "@distilled.cloud/azure/network";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createNetworkName,
  sameId,
  sameSet,
  waitNetworkGoneSlow,
  waitNetworkProvisionedSlow,
  whileNetworkBusy,
} from "./common.ts";

export interface AzureFirewallIpConfiguration {
  /**
   * Name of the IP configuration.
   * @default `ipconfig<index>` (`management` for the management configuration)
   */
  name?: string;
  /**
   * ARM ID of the subnet. Required on the first IP configuration (the
   * VNet's `AzureFirewallSubnet`, at least /26) and on the management
   * configuration (`AzureFirewallManagementSubnet`); omitted on additional
   * configurations.
   */
  subnetId?: string;
  /** ARM ID of a Standard, static public IP address. */
  publicIpAddressId: string;
}

export interface AzureFirewallProps {
  /**
   * Resource group the firewall is created in. Changing it replaces the
   * firewall.
   */
  resourceGroup: string;
  /**
   * Name of the firewall: 1-56 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the firewall.
   */
  name?: string;
  /**
   * Azure location of the firewall (same as its virtual network). Changing
   * it replaces the firewall.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zones to spread the firewall across, e.g. `["1", "2", "3"]`.
   * Changing them replaces the firewall.
   */
  zones?: string[];
  /**
   * Firewall tier. `Basic` requires `managementIpConfiguration`; `Premium`
   * adds TLS inspection and IDPS. Changing it updates the firewall in place.
   * @default "Standard"
   */
  skuTier?: "Basic" | "Standard" | "Premium";
  /**
   * ARM ID of the firewall policy that holds the rules (its tier must match
   * `skuTier`).
   */
  firewallPolicyId?: string;
  /**
   * Data-plane IP configurations. The first one binds the firewall to the
   * VNet's `AzureFirewallSubnet`.
   */
  ipConfigurations: AzureFirewallIpConfiguration[];
  /**
   * Management IP configuration in `AzureFirewallManagementSubnet` (forced
   * tunneling). Required for the Basic tier. Changing it replaces the
   * firewall.
   */
  managementIpConfiguration?: AzureFirewallIpConfiguration;
  /**
   * Threat-intelligence mode when no firewall policy is attached (a policy
   * sets its own).
   * @default Azure's default (`Alert`)
   */
  threatIntelMode?: "Alert" | "Deny" | "Off";
  /**
   * Additional firewall properties, e.g.
   * `{ "Network.DNS.EnableProxy": "true" }`. Azure rejects DNS settings
   * here when `firewallPolicyId` is set: the policy manages them.
   */
  additionalProperties?: Record<string, string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AzureFirewall extends Resource<
  "Azure.Network.AzureFirewall",
  AzureFirewallProps,
  {
    /** Name of the firewall. */
    azureFirewallName: string;
    /** ARM resource ID of the firewall. */
    azureFirewallId: string;
    /** Resource group that holds the firewall. */
    resourceGroup: string;
    /** Location of the firewall. */
    location: string;
    /** Firewall tier. */
    skuTier: string | undefined;
    /** Private IP address of the firewall (the next hop for UDRs). */
    privateIpAddress: string | undefined;
    /** IDs of the public IP addresses attached to the firewall. */
    publicIpAddressIds: string[];
    /** Attached firewall policy ID. */
    firewallPolicyId: string | undefined;
    /** Availability zones of the firewall. */
    zones: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Firewall deployed into a virtual network (`AZFW_VNet`) — a
 * managed, stateful network firewall. Rules live in an attached firewall
 * policy; route subnet traffic through `privateIpAddress` with
 * `Azure.Network.Route` (`nextHopType: "VirtualAppliance"`).
 *
 * The VNet needs a subnet named exactly `AzureFirewallSubnet` (at least
 * /26); the Basic tier also needs `AzureFirewallManagementSubnet`. Each
 * configuration takes a Standard static public IP. Provisioning and
 * deletion take 5-15 minutes. Classic (non-policy) rule collections and
 * Virtual WAN hub firewalls are not modelled.
 *
 * @see https://learn.microsoft.com/azure/firewall/overview
 *
 * ### Creating a Firewall
 * **Example:** Standard firewall with a policy
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("firewall-subnet", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   name: "AzureFirewallSubnet",
 *   addressPrefix: "10.0.0.0/26",
 * });
 * const ip = yield* Azure.Network.PublicIpAddress("firewall-ip", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const firewall = yield* Azure.Network.AzureFirewall("firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   firewallPolicyId: policyId,
 *   ipConfigurations: [
 *     { subnetId: subnet.subnetId, publicIpAddressId: ip.publicIpAddressId },
 *   ],
 * });
 * ```
 *
 * **Example:** Basic firewall with a management configuration
 * ```typescript
 * const firewall = yield* Azure.Network.AzureFirewall("firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   skuTier: "Basic",
 *   firewallPolicyId: basicPolicyId,
 *   ipConfigurations: [
 *     { subnetId: subnet.subnetId, publicIpAddressId: ip.publicIpAddressId },
 *   ],
 *   managementIpConfiguration: {
 *     subnetId: managementSubnet.subnetId,
 *     publicIpAddressId: managementIp.publicIpAddressId,
 *   },
 * });
 * ```
 *
 * ### Routing Through the Firewall
 * **Example:** Default route via the firewall
 * ```typescript
 * yield* Azure.Network.Route("via-firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   routeTable: table.routeTableName,
 *   addressPrefix: "0.0.0.0/0",
 *   nextHopType: "VirtualAppliance",
 *   nextHopIpAddress: firewall.privateIpAddress!,
 * });
 * ```
 *
 * @resource
 */
export const AzureFirewall = Resource<AzureFirewall>(
  "Azure.Network.AzureFirewall",
);

type Observed = network.GetAzureFirewallResponse;

const getFirewall = (
  subscriptionId: string,
  resourceGroupName: string,
  azureFirewallName: string,
) =>
  orUndefinedIfNotFound(
    network.GetAzureFirewall({
      subscriptionId,
      resourceGroupName,
      azureFirewallName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  firewall: Observed,
): AzureFirewall["Attributes"] => {
  const p = firewall.properties;
  return {
    azureFirewallName: name,
    azureFirewallId: firewall.id ?? "",
    resourceGroup,
    location: firewall.location ?? "",
    skuTier: p?.sku?.tier,
    privateIpAddress: p?.ipConfigurations?.[0]?.properties?.privateIPAddress,
    publicIpAddressIds: (p?.ipConfigurations ?? []).flatMap((config) =>
      config.properties?.publicIPAddress?.id
        ? [config.properties.publicIPAddress.id]
        : [],
    ),
    firewallPolicyId: p?.firewallPolicy?.id,
    zones: [...(firewall.zones ?? [])],
    tags: userTags(firewall.tags),
  };
};

const ipConfigurationInput = (
  config: AzureFirewallIpConfiguration,
  name: string,
) => ({
  name: config.name ?? name,
  properties: {
    subnet: config.subnetId === undefined ? undefined : { id: config.subnetId },
    publicIPAddress: { id: config.publicIpAddressId },
  },
});

/** Comparable projection of IP configurations (observed or desired). */
const projectIpConfigurations = (
  configs: ReadonlyArray<{
    readonly name?: string;
    readonly properties?: {
      readonly subnet?: { readonly id?: string };
      readonly publicIPAddress?: { readonly id?: string };
    };
  }>,
) =>
  canonical(
    configs.map((config) => ({
      name: config.name?.toLowerCase(),
      subnet: config.properties?.subnet?.id?.toLowerCase(),
      publicIp: config.properties?.publicIPAddress?.id?.toLowerCase(),
    })),
  );

export const AzureFirewallProvider = () =>
  Provider.succeed(AzureFirewall, {
    stables: [
      "azureFirewallName",
      "azureFirewallId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListAzureFirewallAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAzureFirewallAll", page),
          ),
        );
      return page.value.flatMap((firewall) => {
        const group = resourceGroupOf(firewall.id);
        return hasAnyAlchemyTag(firewall.tags) &&
          group !== undefined &&
          firewall.name !== undefined
          ? [toAttrs(group, firewall.name, firewall)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.azureFirewallName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        (olds !== undefined &&
          canonical(news.managementIpConfiguration) !==
            canonical(olds.managementIpConfiguration))
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
        output?.azureFirewallName ??
        olds?.name ??
        (yield* createNetworkName(id, 56));
      const observed = yield* getFirewall(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.azureFirewallName ??
        (yield* createNetworkName(id, 56));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        azureFirewallName: name,
      };
      const label = `Azure Firewall ${name}`;
      const get = getFirewall(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;
      const p = observed?.properties;

      // Desired state. Unset optional props keep the observed value.
      const skuTier = news.skuTier ?? "Standard";
      const ipConfigurations = news.ipConfigurations.map((config, i) =>
        ipConfigurationInput(config, `ipconfig${i + 1}`),
      );
      const managementIpConfiguration =
        news.managementIpConfiguration === undefined
          ? undefined
          : ipConfigurationInput(news.managementIpConfiguration, "management");
      const threatIntelMode = news.threatIntelMode ?? p?.threatIntelMode;
      const additionalProperties = news.additionalProperties ?? {};

      // Ensure + sync: one PUT when missing or any modelled aspect drifts;
      // a tags-only delta is a PATCH.
      const differs =
        observed === undefined ||
        p?.sku?.tier !== skuTier ||
        !sameId(p?.firewallPolicy?.id, news.firewallPolicyId) ||
        projectIpConfigurations(p?.ipConfigurations ?? []) !==
          projectIpConfigurations(ipConfigurations) ||
        p?.threatIntelMode !== threatIntelMode ||
        canonical(p?.additionalProperties ?? {}) !==
          canonical(additionalProperties);
      if (differs) {
        yield* network
          .AzureFirewallsCreateOrUpdate({
            ...where,
            location,
            tags,
            zones: news.zones,
            properties: {
              sku: { name: "AZFW_VNet", tier: skuTier },
              firewallPolicy:
                news.firewallPolicyId === undefined
                  ? undefined
                  : { id: news.firewallPolicyId },
              ipConfigurations,
              managementIpConfiguration,
              threatIntelMode,
              additionalProperties,
            },
          })
          .pipe(Effect.retry(whileNetworkBusy));
      } else if (observed !== undefined && tagsDiffer(observed.tags, tags)) {
        yield* network
          .UpdateAzureFirewallTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisionedSlow(label, get);
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteAzureFirewall({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          azureFirewallName: output.azureFirewallName,
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGoneSlow(
        `Azure Firewall ${output.azureFirewallName}`,
        getFirewall(
          subscriptionId,
          output.resourceGroup,
          output.azureFirewallName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
