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
  stackAndStage,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createNetworkName,
  ref,
  sameId,
  sameSet,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

export interface SubnetServiceEndpoint {
  /** Service, e.g. `Microsoft.Storage` or `Microsoft.KeyVault`. */
  service: string;
  /**
   * Regions the endpoint applies to.
   * @default the virtual network's region (Azure's default)
   */
  locations?: string[];
}

export interface SubnetDelegation {
  /**
   * Name of the delegation.
   * @default the service name
   */
  name?: string;
  /** Service the subnet is delegated to, e.g. `Microsoft.App/environments`. */
  serviceName: string;
}

export interface SubnetProps {
  /** Resource group of the virtual network. Changing it replaces the subnet. */
  resourceGroup: string;
  /** Name of the parent virtual network. Changing it replaces the subnet. */
  virtualNetwork: string;
  /**
   * Name of the subnet: 1-80 letters, digits, `_`, `.`, and `-`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the subnet.
   */
  name?: string;
  /**
   * Address prefix in CIDR notation, inside the VNet address space, e.g.
   * `10.0.1.0/24`. Set either `addressPrefix` or `addressPrefixes`.
   * Changing it fails while IPs in the subnet are in use.
   */
  addressPrefix?: string;
  /** Multiple address prefixes (e.g. IPv4 + IPv6). */
  addressPrefixes?: string[];
  /** ARM ID of a network security group to associate. */
  networkSecurityGroupId?: string;
  /** ARM ID of a route table to associate. */
  routeTableId?: string;
  /** ARM ID of a NAT gateway for outbound traffic. */
  natGatewayId?: string;
  /** Service endpoints enabled on the subnet. */
  serviceEndpoints?: SubnetServiceEndpoint[];
  /** Delegations of the subnet to Azure services. */
  delegations?: SubnetDelegation[];
  /**
   * Network policies (NSG / route table) applied to private endpoints in
   * the subnet.
   * @default Azure's default (`Disabled`)
   */
  privateEndpointNetworkPolicies?:
    | "Enabled"
    | "Disabled"
    | "NetworkSecurityGroupEnabled"
    | "RouteTableEnabled";
  /**
   * Network policies applied to private link services in the subnet.
   * @default Azure's default (`Enabled`)
   */
  privateLinkServiceNetworkPolicies?: "Enabled" | "Disabled";
  /**
   * Whether VMs without an explicit outbound method get default outbound
   * internet access. Set `false` for a private subnet.
   * @default Azure's default
   */
  defaultOutboundAccess?: boolean;
}

export interface Subnet extends Resource<
  "Azure.Network.Subnet",
  SubnetProps,
  {
    /** Name of the subnet. */
    subnetName: string;
    /** ARM resource ID of the subnet. */
    subnetId: string;
    /** Name of the parent virtual network. */
    virtualNetwork: string;
    /** Resource group of the virtual network. */
    resourceGroup: string;
    /** Address prefix (single-prefix subnets). */
    addressPrefix: string | undefined;
    /** Address prefixes (multi-prefix subnets). */
    addressPrefixes: string[];
    /** Associated network security group ID. */
    networkSecurityGroupId: string | undefined;
    /** Associated route table ID. */
    routeTableId: string | undefined;
    /** Associated NAT gateway ID. */
    natGatewayId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A subnet of an Azure virtual network. Network interfaces, private
 * endpoints, and internal load balancers are placed in subnets; network
 * security groups, route tables, and NAT gateways attach to them.
 *
 * Subnets of one virtual network are written one at a time by Azure; the
 * provider retries `AnotherOperationInProgress` so sibling subnets can be
 * declared side by side.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-network-manage-subnet
 *
 * ### Creating a Subnet
 * **Example:** Subnet in a virtual network
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * ```
 *
 * ### Associations
 * **Example:** Subnet with an NSG, route table, and NAT gateway
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 *   routeTableId: routes.routeTableId,
 *   natGatewayId: nat.natGatewayId,
 * });
 * ```
 *
 * ### Service Endpoints and Delegation
 * **Example:** Subnet delegated to Azure Container Apps
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("apps", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.2.0/23",
 *   serviceEndpoints: [{ service: "Microsoft.Storage" }],
 *   delegations: [{ serviceName: "Microsoft.App/environments" }],
 * });
 * ```
 *
 * @resource
 */
export const Subnet = Resource<Subnet>("Azure.Network.Subnet");

type Observed = network.GetSubnetResponse;

const getSubnet = (
  subscriptionId: string,
  resourceGroupName: string,
  virtualNetworkName: string,
  subnetName: string,
) =>
  orUndefinedIfNotFound(
    network.GetSubnet({
      subscriptionId,
      resourceGroupName,
      virtualNetworkName,
      subnetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  virtualNetwork: string,
  name: string,
  subnet: Observed,
): Subnet["Attributes"] => ({
  subnetName: name,
  subnetId: subnet.id ?? "",
  virtualNetwork,
  resourceGroup,
  addressPrefix: subnet.properties?.addressPrefix,
  addressPrefixes: [...(subnet.properties?.addressPrefixes ?? [])],
  networkSecurityGroupId: subnet.properties?.networkSecurityGroup?.id,
  routeTableId: subnet.properties?.routeTable?.id,
  natGatewayId: subnet.properties?.natGateway?.id,
});

const prefixesOf = (props: {
  addressPrefix?: string;
  addressPrefixes?: ReadonlyArray<string>;
}) =>
  props.addressPrefixes && props.addressPrefixes.length > 0
    ? props.addressPrefixes
    : props.addressPrefix !== undefined
      ? [props.addressPrefix]
      : [];

export const SubnetProvider = () =>
  Provider.succeed(Subnet, {
    stables: ["subnetName", "subnetId", "virtualNetwork", "resourceGroup"],

    // Subnets live inside a virtual network; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.virtualNetwork, output.virtualNetwork) ||
        (news.name !== undefined && !sameId(news.name, output.subnetName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const virtualNetwork = output?.virtualNetwork ?? olds?.virtualNetwork;
      if (resourceGroup === undefined || virtualNetwork === undefined) {
        return undefined;
      }
      const name =
        output?.subnetName ?? olds?.name ?? (yield* createNetworkName(id));
      const observed = yield* getSubnet(
        subscriptionId,
        resourceGroup,
        virtualNetwork,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, virtualNetwork, name, observed);
      // Subnets carry no tags: ownership follows the parent VNet's stack
      // and stage tags.
      const vnet = yield* orUndefinedIfNotFound(
        network.GetVirtualNetwork({
          subscriptionId,
          resourceGroupName: resourceGroup,
          virtualNetworkName: virtualNetwork,
        }),
      );
      const { stack, stage } = yield* stackAndStage;
      return vnet?.tags?.["alchemy::stack"] === stack &&
        vnet.tags["alchemy::stage"] === stage
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, virtualNetwork } = news;
      const name =
        news.name ?? output?.subnetName ?? (yield* createNetworkName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualNetworkName: virtualNetwork,
        subnetName: name,
      };
      const label = `subnet ${virtualNetwork}/${name}`;
      const get = getSubnet(
        subscriptionId,
        resourceGroup,
        virtualNetwork,
        name,
      );

      // Observe.
      let observed = yield* get;
      const props = observed?.properties;

      // Desired state. Unset policy props keep the observed value so an
      // unrelated update never flips them.
      const desiredPrefixes = prefixesOf(news);
      const serviceEndpoints = (news.serviceEndpoints ?? []).map((e) => ({
        service: e.service,
        locations: e.locations,
      }));
      const delegations = (news.delegations ?? []).map((d) => ({
        name: d.name ?? d.serviceName,
        properties: { serviceName: d.serviceName },
      }));
      const desired = {
        addressPrefix:
          news.addressPrefixes && news.addressPrefixes.length > 0
            ? undefined
            : news.addressPrefix,
        addressPrefixes:
          news.addressPrefixes && news.addressPrefixes.length > 0
            ? news.addressPrefixes
            : undefined,
        networkSecurityGroup: ref(news.networkSecurityGroupId),
        routeTable: ref(news.routeTableId),
        natGateway: ref(news.natGatewayId),
        serviceEndpoints,
        delegations,
        privateEndpointNetworkPolicies:
          news.privateEndpointNetworkPolicies ??
          props?.privateEndpointNetworkPolicies,
        privateLinkServiceNetworkPolicies:
          news.privateLinkServiceNetworkPolicies ??
          props?.privateLinkServiceNetworkPolicies,
        defaultOutboundAccess:
          news.defaultOutboundAccess ?? props?.defaultOutboundAccess,
        serviceEndpointPolicies: props?.serviceEndpointPolicies?.flatMap(
          (policy) => (policy.id === undefined ? [] : [{ id: policy.id }]),
        ),
      };

      // Ensure + sync: one full PUT when missing or when any aspect drifts.
      const observedEndpoints = (props?.serviceEndpoints ?? []).map((e) => ({
        service: e.service,
        locations:
          news.serviceEndpoints?.find((d) => d.service === e.service)
            ?.locations === undefined
            ? undefined
            : e.locations,
      }));
      const observedDelegations = (props?.delegations ?? []).map((d) => ({
        name: d.name,
        properties: { serviceName: d.properties?.serviceName },
      }));
      const differs =
        observed === undefined ||
        !sameSet(prefixesOf(props ?? {}), desiredPrefixes) ||
        !sameId(props?.networkSecurityGroup?.id, news.networkSecurityGroupId) ||
        !sameId(props?.routeTable?.id, news.routeTableId) ||
        !sameId(props?.natGateway?.id, news.natGatewayId) ||
        canonical(
          [...observedEndpoints].sort((a, b) =>
            (a.service ?? "").localeCompare(b.service ?? ""),
          ),
        ) !==
          canonical(
            [...serviceEndpoints].sort((a, b) =>
              a.service.localeCompare(b.service),
            ),
          ) ||
        canonical(observedDelegations) !== canonical(delegations) ||
        props?.privateEndpointNetworkPolicies !==
          desired.privateEndpointNetworkPolicies ||
        props?.privateLinkServiceNetworkPolicies !==
          desired.privateLinkServiceNetworkPolicies ||
        props?.defaultOutboundAccess !== desired.defaultOutboundAccess;
      if (differs) {
        yield* network
          .SubnetsCreateOrUpdate({ ...where, properties: desired })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(label, get);
      return toAttrs(resourceGroup, virtualNetwork, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteSubnet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualNetworkName: output.virtualNetwork,
          subnetName: output.subnetName,
        }),
      ).pipe(Effect.retry(whileInUse(["SubnetInUse"])));
      yield* waitNetworkGone(
        `subnet ${output.virtualNetwork}/${output.subnetName}`,
        getSubnet(
          subscriptionId,
          output.resourceGroup,
          output.virtualNetwork,
          output.subnetName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Network.VirtualNetwork",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
