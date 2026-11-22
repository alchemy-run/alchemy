import * as network from "@distilled.cloud/azure/network";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /**
   * Service, e.g. `Microsoft.Storage`, `Microsoft.KeyVault`, `Microsoft.Sql`,
   * or `Microsoft.AzureCosmosDB`.
   */
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
  /**
   * Service the subnet is delegated to, e.g. `Microsoft.App/environments`
   * (Container Apps), `Microsoft.Web/serverFarms` (App Service and
   * Functions VNet integration), or `Microsoft.Web/hostingEnvironments`
   * (App Service Environment).
   */
  serviceName: string;
}

export interface SubnetProps {
  /**
   * Resource group of the virtual network. Changing it replaces the subnet.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the parent virtual network, e.g. `vnet.virtualNetworkName`.
   * Changing it replaces the subnet.
   */
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
  /**
   * Multiple address prefixes in CIDR notation, e.g. an IPv4 /24 and an
   * IPv6 /64 for a dual-stack subnet. Takes precedence over
   * `addressPrefix`. Changing it fails while IPs in the subnet are in use.
   */
  addressPrefixes?: string[];
  /**
   * ARM ID of a network security group to associate. Updated in place.
   * @default no network security group
   */
  networkSecurityGroupId?: string;
  /**
   * ARM ID of a route table to associate. Updated in place.
   * @default Azure's system routes only
   */
  routeTableId?: string;
  /**
   * ARM ID of a NAT gateway for outbound traffic. Updated in place.
   * @default no NAT gateway
   */
  natGatewayId?: string;
  /**
   * Service endpoints enabled on the subnet. Updated in place.
   * @default []
   */
  serviceEndpoints?: SubnetServiceEndpoint[];
  /**
   * Delegations of the subnet to Azure services. A delegated subnet can
   * only hold that service's resources. Updated in place.
   * @default []
   */
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
    /** Address prefix in CIDR notation (single-prefix subnets). */
    addressPrefix: string | undefined;
    /** Address prefixes in CIDR notation (multi-prefix subnets). */
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
 * A subnet of an Azure virtual network
 * (`Microsoft.Network/virtualNetworks/subnets`): a range of the network's
 * address space. Network interfaces, private endpoints, internal load
 * balancers, and VNet-integrated services (Container Apps environments,
 * App Service apps) are placed in subnets; network security groups, route
 * tables, and NAT gateways attach to them.
 *
 * A new subnet has no network security group, no route table, no
 * service endpoints, and no delegation. Azure reserves 5 addresses in
 * every subnet (the first four and the last), so a /24 holds 251 hosts.
 * Subnets of one virtual network are written one at a time by Azure;
 * Alchemy retries `AnotherOperationInProgress` so sibling subnets can be
 * declared side by side. Subnets carry no tags: ownership follows the
 * parent virtual network's `alchemy::stack` and `alchemy::stage` tags.
 *
 * :::caution[Changing `name`, `virtualNetwork`, or `resourceGroup` replaces the subnet]
 * Alchemy creates a new subnet and deletes the old one. The old subnet
 * cannot be deleted while network interfaces, private endpoints, or
 * delegated services still use it (Alchemy retries `SubnetInUse` for a
 * while, then fails), so move those resources first. They get new
 * private IPs.
 * :::
 *
 * :::caution[The parent virtual network must exist]
 * Declare the `Azure.Network.VirtualNetwork` in the same stack and pass
 * `vnet.virtualNetworkName`, or pass the name of an existing network in
 * `resourceGroup`. The address prefix must sit inside the network's
 * address space and must not overlap a sibling subnet.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-network-manage-subnet
 *
 * ### Creating a Subnet
 * **Example:** Subnet in a virtual network
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * ```
 *
 * **Example:** Subnet with a fixed name
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   name: "snet-app",
 *   addressPrefix: "10.0.1.0/24",
 * });
 * ```
 *
 * **Example:** Dual-stack subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16", "fd00:db8:deca::/48"],
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefixes: ["10.0.1.0/24", "fd00:db8:deca:1::/64"],
 * });
 * ```
 *
 * ### Network Security Groups
 * Associate an NSG to filter traffic to and from every resource in the
 * subnet. Add rules with `Azure.Network.SecurityRule`.
 *
 * **Example:** Allow HTTPS from the internet
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web");
 * yield* Azure.Network.SecurityRule("allow-https", {
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 100,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   sourceAddressPrefix: "Internet",
 *   destinationPortRange: "443",
 * });
 * const subnet = yield* Azure.Network.Subnet("web", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 * });
 * ```
 *
 * ### Routing
 * Associate a route table to override Azure's system routes, e.g. to send
 * internet-bound traffic through a firewall.
 *
 * **Example:** Force traffic through an appliance
 * ```typescript
 * const routes = yield* Azure.Network.RouteTable("egress");
 * yield* Azure.Network.Route("default", {
 *   routeTable: routes.routeTableName,
 *   addressPrefix: "0.0.0.0/0",
 *   nextHopType: "VirtualAppliance",
 *   nextHopIpAddress: "10.0.0.4",
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   routeTableId: routes.routeTableId,
 * });
 * ```
 *
 * ### Outbound Internet Access
 * Attach a NAT gateway so every resource in the subnet leaves through
 * the gateway's static public IPs. Set `defaultOutboundAccess: false` to
 * make the subnet private: VMs without a NAT gateway, load balancer, or
 * public IP then have no internet access.
 *
 * **Example:** Static egress IP through a NAT gateway
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("egress");
 * const nat = yield* Azure.Network.NatGateway("egress", {
 *   publicIpAddressIds: [ip.publicIpAddressId],
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   natGatewayId: nat.natGatewayId,
 * });
 * ```
 *
 * **Example:** Private subnet with no default outbound access
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("data", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.2.0/24",
 *   defaultOutboundAccess: false,
 * });
 * ```
 *
 * ### Service Endpoints
 * A service endpoint routes the subnet's traffic to an Azure service over
 * the Azure backbone, so the service can allow the subnet in its firewall.
 *
 * **Example:** Allow only the subnet into a Key Vault
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   serviceEndpoints: [{ service: "Microsoft.KeyVault" }],
 * });
 * const vault = yield* Azure.KeyVault.Vault("secrets", {
 *   networkAcls: {
 *     defaultAction: "Deny",
 *     virtualNetworkRules: [subnet.subnetId],
 *   },
 * });
 * ```
 *
 * ### Delegating to Container Apps
 * A Container Apps environment with workload profiles needs a subnet of
 * /27 or larger delegated to `Microsoft.App/environments`. Changing the
 * environment's `vnetConfiguration` replaces the environment.
 *
 * **Example:** Container Apps environment in your network
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("apps", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.2.0/23",
 *   delegations: [{ serviceName: "Microsoft.App/environments" }],
 * });
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   vnetConfiguration: { infrastructureSubnetId: subnet.subnetId },
 * });
 * ```
 *
 * **Example:** Internal-only environment
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   vnetConfiguration: {
 *     infrastructureSubnetId: subnet.subnetId,
 *     internal: true,
 *   },
 * });
 * ```
 *
 * ### Delegating to App Service
 * Regional VNet integration routes a Web App's or Function App's outbound
 * traffic through a subnet delegated to `Microsoft.Web/serverFarms`. The
 * plan must be Basic (`B1`) or higher.
 *
 * **Example:** VNet-integrated Web App
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("web-out", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.4.0/26",
 *   delegations: [{ serviceName: "Microsoft.Web/serverFarms" }],
 * });
 * const api = yield* Azure.Web.WebApp("Api", {
 *   main: "./src/api.ts",
 *   sku: "B1",
 *   virtualNetworkSubnetId: subnet.subnetId,
 * });
 * ```
 *
 * ### Private Endpoints
 * Place private endpoints in a regular (non-delegated) subnet. Set
 * `privateEndpointNetworkPolicies: "Enabled"` to apply the subnet's NSG
 * and route table to them.
 *
 * **Example:** Subnet for private endpoints
 * ```typescript
 * const endpoints = yield* Azure.Network.Subnet("endpoints", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.3.0/24",
 *   privateEndpointNetworkPolicies: "Enabled",
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 * });
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   publicNetworkAccess: "Disabled",
 * });
 * yield* Azure.Network.PrivateEndpoint("files-blob", {
 *   subnetId: endpoints.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: account.storageAccountId, groupIds: ["blob"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Subnet = GroupedResource<Subnet>("Azure.Network.Subnet");

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

const prefixesOf = (props: { addressPrefix?: string; addressPrefixes?: ReadonlyArray<string> }) =>
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
      const name = output?.subnetName ?? olds?.name ?? (yield* createNetworkName(id));
      const observed = yield* getSubnet(subscriptionId, resourceGroup, virtualNetwork, name);
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
      return vnet?.tags?.["alchemy::stack"] === stack && vnet.tags["alchemy::stage"] === stage
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, virtualNetwork } = news;
      const name = news.name ?? output?.subnetName ?? (yield* createNetworkName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualNetworkName: virtualNetwork,
        subnetName: name,
      };
      const label = `subnet ${virtualNetwork}/${name}`;
      const get = getSubnet(subscriptionId, resourceGroup, virtualNetwork, name);

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
          news.addressPrefixes && news.addressPrefixes.length > 0 ? undefined : news.addressPrefix,
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
          news.privateEndpointNetworkPolicies ?? props?.privateEndpointNetworkPolicies,
        privateLinkServiceNetworkPolicies:
          news.privateLinkServiceNetworkPolicies ?? props?.privateLinkServiceNetworkPolicies,
        defaultOutboundAccess: news.defaultOutboundAccess ?? props?.defaultOutboundAccess,
        serviceEndpointPolicies: props?.serviceEndpointPolicies?.flatMap((policy) =>
          policy.id === undefined ? [] : [{ id: policy.id }],
        ),
      };

      // Ensure + sync: one full PUT when missing or when any aspect drifts.
      const observedEndpoints = (props?.serviceEndpoints ?? []).map((e) => ({
        service: e.service,
        locations:
          news.serviceEndpoints?.find((d) => d.service === e.service)?.locations === undefined
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
          [...observedEndpoints].sort((a, b) => (a.service ?? "").localeCompare(b.service ?? "")),
        ) !== canonical([...serviceEndpoints].sort((a, b) => a.service.localeCompare(b.service))) ||
        canonical(observedDelegations) !== canonical(delegations) ||
        props?.privateEndpointNetworkPolicies !== desired.privateEndpointNetworkPolicies ||
        props?.privateLinkServiceNetworkPolicies !== desired.privateLinkServiceNetworkPolicies ||
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
        getSubnet(subscriptionId, output.resourceGroup, output.virtualNetwork, output.subnetName),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Network.VirtualNetwork", "Azure.Resources.ResourceGroup"],
    },
  });
