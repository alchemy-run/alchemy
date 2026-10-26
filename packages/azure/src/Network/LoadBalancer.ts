import * as network from "@distilled.cloud/azure/network";
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
  resourceGroupOf,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  canonical,
  createNetworkName,
  lower,
  ref,
  sameId,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileNetworkBusy,
} from "./common.ts";

export interface LoadBalancerFrontendIpConfiguration {
  /** Name of the frontend; rules reference it by this name. */
  name: string;
  /** ARM ID of a public IP (public load balancer). */
  publicIpAddressId?: string;
  /** ARM ID of a public IP prefix (public load balancer). */
  publicIpPrefixId?: string;
  /** ARM ID of the subnet (internal load balancer). */
  subnetId?: string;
  /**
   * Static private IP in the subnet (internal load balancer).
   * @default a dynamically allocated address
   */
  privateIpAddress?: string;
  /**
   * Private IP version (internal load balancer).
   * @default "IPv4"
   */
  privateIpAddressVersion?: "IPv4" | "IPv6";
  /**
   * Availability zones of an internal frontend, e.g. `["1", "2", "3"]`
   * (zone-redundant) or `["1"]` (zonal). A public frontend takes the zones
   * of its public IP.
   * @default Azure's default for the region
   */
  zones?: string[];
}

export interface LoadBalancerBackendAddressPoolSpec {
  /**
   * Name of the pool; rules reference it by this name, and the
   * `backendAddressPoolIds` attribute is keyed by it.
   */
  name: string;
}

export interface LoadBalancerProbe {
  /** Name of the probe; rules reference it by this name. */
  name: string;
  /**
   * Probe protocol. `Tcp` passes when the port accepts a connection;
   * `Http` and `Https` pass on a 200 response.
   */
  protocol: "Tcp" | "Http" | "Https";
  /** Port probed on each backend (1-65535). */
  port: number;
  /** URI probed for `Http` / `Https` probes, e.g. `/healthz`. Required for them. */
  requestPath?: string;
  /**
   * Seconds between probes (5 or more).
   * @default 5
   */
  intervalInSeconds?: number;
  /**
   * Consecutive failures (or successes) before a backend is marked down
   * (or up).
   * @default 1
   */
  probeThreshold?: number;
}

export interface LoadBalancingRule {
  /** Name of the rule. */
  name: string;
  /** Name of the frontend IP configuration the rule listens on. */
  frontendIpConfiguration: string;
  /** Name of the backend address pool traffic is sent to. */
  backendAddressPool?: string;
  /**
   * Name of the health probe. Backends that fail it get no new flows.
   * @default no probe
   */
  probe?: string;
  /** Transport protocol (`All` for HA ports on internal load balancers). */
  protocol: "Tcp" | "Udp" | "All";
  /** Frontend port (0-65534; 0 with `All`). */
  frontendPort: number;
  /**
   * Backend port (0-65535; 0 with `All`).
   * @default the frontend port
   */
  backendPort?: number;
  /**
   * TCP idle timeout in minutes (4-100).
   * @default 4
   */
  idleTimeoutInMinutes?: number;
  /**
   * Enable floating IP (direct server return).
   * @default false
   */
  enableFloatingIP?: boolean;
  /**
   * Send TCP resets on idle timeout.
   * @default false
   */
  enableTcpReset?: boolean;
  /**
   * Disable SNAT through the rule's frontend for outbound traffic (use
   * outbound rules or a NAT gateway instead).
   * @default false
   */
  disableOutboundSnat?: boolean;
  /**
   * Session persistence.
   * @default "Default"
   */
  loadDistribution?: "Default" | "SourceIP" | "SourceIPProtocol";
}

export interface LoadBalancerOutboundRule {
  /** Name of the outbound rule. */
  name: string;
  /** Names of the frontend IP configurations used for SNAT. */
  frontendIpConfigurations: string[];
  /** Name of the backend address pool whose traffic is SNATed. */
  backendAddressPool: string;
  /** Transport protocol. */
  protocol: "Tcp" | "Udp" | "All";
  /**
   * SNAT ports allocated per backend instance, a multiple of 8. Each
   * frontend IP provides 64,000 ports to share across the pool.
   * @default 0 (Azure allocates ports by backend pool size)
   */
  allocatedOutboundPorts?: number;
  /**
   * Send TCP resets on idle timeout.
   * @default false
   */
  enableTcpReset?: boolean;
  /**
   * Outbound flow idle timeout in minutes (4-120).
   * @default 4
   */
  idleTimeoutInMinutes?: number;
}

export interface LoadBalancerProps {
  /**
   * Resource group the load balancer is created in. Changing it replaces
   * the load balancer.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the load balancer: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the load balancer.
   */
  name?: string;
  /**
   * Azure location of the load balancer. Changing it replaces the load
   * balancer.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * SKU: `Standard`, or `Gateway` to chain network virtual appliances.
   * Basic load balancers were retired in 2025. Changing it replaces the
   * load balancer.
   * @default "Standard"
   */
  sku?: "Standard" | "Gateway";
  /**
   * SKU tier: `Regional`, or `Global` for cross-region load balancers.
   * Changing it replaces the load balancer.
   * @default "Regional"
   */
  tier?: "Regional" | "Global";
  /**
   * Frontend IP configurations (public or internal). Updated in place.
   */
  frontendIpConfigurations: LoadBalancerFrontendIpConfiguration[];
  /**
   * Backend address pools. Network interfaces join a pool through
   * `NetworkInterface.ipConfigurations[].loadBalancerBackendAddressPoolIds`
   * using the IDs in the `backendAddressPoolIds` attribute. Pools created
   * with `Azure.Network.LoadBalancerBackendAddressPool` are kept. Updated
   * in place.
   * @default []
   */
  backendAddressPools?: LoadBalancerBackendAddressPoolSpec[];
  /**
   * Health probes. Updated in place.
   * @default []
   */
  probes?: LoadBalancerProbe[];
  /**
   * Load-balancing rules. Updated in place.
   * @default []
   */
  loadBalancingRules?: LoadBalancingRule[];
  /**
   * Outbound (SNAT) rules. Updated in place.
   * @default []
   */
  outboundRules?: LoadBalancerOutboundRule[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface LoadBalancer extends Resource<
  "Azure.Network.LoadBalancer",
  LoadBalancerProps,
  {
    /** Name of the load balancer. */
    loadBalancerName: string;
    /** ARM resource ID of the load balancer. */
    loadBalancerId: string;
    /** Resource group that holds the load balancer. */
    resourceGroup: string;
    /** Azure location of the load balancer, e.g. `eastus`. */
    location: string;
    /** SKU name: `Standard` or `Gateway`. */
    sku: string;
    /** SKU tier: `Regional` or `Global`. */
    tier: string;
    /** Frontend IP configuration IDs keyed by name. */
    frontendIpConfigurationIds: Record<string, string>;
    /**
     * Private IPs of internal frontends keyed by frontend name, e.g.
     * `{ private: "10.0.1.100" }`.
     */
    frontendPrivateIpAddresses: Record<string, string>;
    /**
     * Backend address pool IDs keyed by name; pass one in a NIC's
     * `loadBalancerBackendAddressPoolIds`.
     */
    backendAddressPoolIds: Record<string, string>;
    /** Probe IDs keyed by name. */
    probeIds: Record<string, string>;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Load Balancer (`Microsoft.Network/loadBalancers`, Standard
 * SKU): layer-4 TCP/UDP load balancing for VMs and scale sets, public
 * (internet-facing, through a public IP) or internal (private IP in a
 * subnet). Azure's counterpart to an AWS Network Load Balancer.
 *
 * Frontends, backend pools, probes, load-balancing rules, and outbound
 * rules are declared inline and cross-reference each other by name.
 * Alchemy keeps inbound NAT rules (`Azure.Network.InboundNatRule`) and
 * pools (`Azure.Network.LoadBalancerBackendAddressPool`) created outside
 * this resource. A Standard load balancer is closed to inbound traffic:
 * the backends' NSGs must allow it.
 *
 * :::caution[Changing `name`, `location`, `resourceGroup`, `sku`, or `tier` replaces the load balancer]
 * Alchemy creates a new load balancer and deletes the old one. The pool,
 * frontend, and probe IDs change, so every NIC in a pool is updated, and
 * traffic stops until the backends join the new pools.
 * :::
 *
 * :::caution[Frontends, NICs, and the load balancer must share one region]
 * A public frontend needs a Standard public IP in the same region. An
 * internal frontend needs a subnet of a virtual network in that region.
 * :::
 *
 * @see https://learn.microsoft.com/azure/load-balancer/load-balancer-overview
 *
 * ### Creating a Public Load Balancer
 * A public load balancer receives internet traffic on a Standard public
 * IP and spreads it across the backend pool.
 *
 * **Example:** HTTP load balancer with a health probe
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("lb");
 * const lb = yield* Azure.Network.LoadBalancer("web", {
 *   frontendIpConfigurations: [
 *     { name: "public", publicIpAddressId: ip.publicIpAddressId },
 *   ],
 *   backendAddressPools: [{ name: "web" }],
 *   probes: [{ name: "http", protocol: "Http", port: 80, requestPath: "/" }],
 *   loadBalancingRules: [
 *     {
 *       name: "http",
 *       frontendIpConfiguration: "public",
 *       backendAddressPool: "web",
 *       probe: "http",
 *       protocol: "Tcp",
 *       frontendPort: 80,
 *       disableOutboundSnat: true,
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Load balancer with a fixed name and region
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("lb", { location: "westeurope" });
 * const lb = yield* Azure.Network.LoadBalancer("web", {
 *   name: "lb-web-prod",
 *   location: "westeurope",
 *   frontendIpConfigurations: [
 *     { name: "public", publicIpAddressId: ip.publicIpAddressId },
 *   ],
 *   tags: { env: "prod" },
 * });
 * ```
 *
 * ### Internal Load Balancer
 * An internal frontend takes a private IP in a subnet. Use it for
 * private tiers and for network virtual appliances.
 *
 * **Example:** Zone-redundant internal frontend on a dynamic IP
 * ```typescript
 * const lb = yield* Azure.Network.LoadBalancer("api", {
 *   frontendIpConfigurations: [
 *     { name: "private", subnetId: subnet.subnetId, zones: ["1", "2", "3"] },
 *   ],
 *   backendAddressPools: [{ name: "api" }],
 *   probes: [{ name: "tcp", protocol: "Tcp", port: 8080 }],
 *   loadBalancingRules: [
 *     {
 *       name: "api",
 *       frontendIpConfiguration: "private",
 *       backendAddressPool: "api",
 *       probe: "tcp",
 *       protocol: "Tcp",
 *       frontendPort: 80,
 *       backendPort: 8080,
 *     },
 *   ],
 * });
 * // lb.frontendPrivateIpAddresses.private is the allocated address
 * ```
 *
 * **Example:** HA-ports internal load balancer
 * ```typescript
 * const lb = yield* Azure.Network.LoadBalancer("internal", {
 *   frontendIpConfigurations: [
 *     { name: "private", subnetId: subnet.subnetId, privateIpAddress: "10.0.1.100" },
 *   ],
 *   backendAddressPools: [{ name: "nva" }],
 *   probes: [{ name: "tcp", protocol: "Tcp", port: 22 }],
 *   loadBalancingRules: [
 *     {
 *       name: "ha-ports",
 *       frontendIpConfiguration: "private",
 *       backendAddressPool: "nva",
 *       probe: "tcp",
 *       protocol: "All",
 *       frontendPort: 0,
 *       backendPort: 0,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Health Probes
 * A backend that fails its probe `probeThreshold` times in a row gets no
 * new flows until it passes again. `Http` and `Https` probes need a 200
 * response from `requestPath`.
 *
 * **Example:** HTTPS health check every 10 seconds
 * ```typescript
 * const lb = yield* Azure.Network.LoadBalancer("web", {
 *   frontendIpConfigurations: [
 *     { name: "public", publicIpAddressId: ip.publicIpAddressId },
 *   ],
 *   backendAddressPools: [{ name: "web" }],
 *   probes: [
 *     {
 *       name: "healthz",
 *       protocol: "Https",
 *       port: 443,
 *       requestPath: "/healthz",
 *       intervalInSeconds: 10,
 *       probeThreshold: 3,
 *     },
 *   ],
 *   loadBalancingRules: [
 *     {
 *       name: "https",
 *       frontendIpConfiguration: "public",
 *       backendAddressPool: "web",
 *       probe: "healthz",
 *       protocol: "Tcp",
 *       frontendPort: 443,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Load-Balancing Rules
 * A rule maps a frontend port to a backend port. `loadDistribution`
 * pins a client to one backend, and `enableTcpReset` tells both ends when
 * an idle flow times out.
 *
 * **Example:** Sticky sessions with a 15-minute idle timeout
 * ```typescript
 * const lb = yield* Azure.Network.LoadBalancer("app", {
 *   frontendIpConfigurations: [
 *     { name: "public", publicIpAddressId: ip.publicIpAddressId },
 *   ],
 *   backendAddressPools: [{ name: "app" }],
 *   probes: [{ name: "tcp", protocol: "Tcp", port: 8080 }],
 *   loadBalancingRules: [
 *     {
 *       name: "app",
 *       frontendIpConfiguration: "public",
 *       backendAddressPool: "app",
 *       probe: "tcp",
 *       protocol: "Tcp",
 *       frontendPort: 80,
 *       backendPort: 8080,
 *       loadDistribution: "SourceIP",
 *       idleTimeoutInMinutes: 15,
 *       enableTcpReset: true,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Outbound Rules
 * An outbound rule gives the backends explicit SNAT through the frontend
 * IPs, with a fixed number of ports per instance. Set
 * `disableOutboundSnat: true` on the load-balancing rules so only the
 * outbound rule is used. For outbound only, prefer an
 * `Azure.Network.NatGateway` on the subnet.
 *
 * **Example:** 1,024 SNAT ports per backend
 * ```typescript
 * const lb = yield* Azure.Network.LoadBalancer("web", {
 *   frontendIpConfigurations: [
 *     { name: "public", publicIpAddressId: ip.publicIpAddressId },
 *   ],
 *   backendAddressPools: [{ name: "web" }],
 *   loadBalancingRules: [
 *     {
 *       name: "http",
 *       frontendIpConfiguration: "public",
 *       backendAddressPool: "web",
 *       protocol: "Tcp",
 *       frontendPort: 80,
 *       disableOutboundSnat: true,
 *     },
 *   ],
 *   outboundRules: [
 *     {
 *       name: "egress",
 *       frontendIpConfigurations: ["public"],
 *       backendAddressPool: "web",
 *       protocol: "All",
 *       allocatedOutboundPorts: 1024,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Joining the Backend Pool
 * A NIC joins a pool by ID from `lb.backendAddressPoolIds`, keyed by pool
 * name.
 *
 * **Example:** Network interface in the backend pool
 * ```typescript
 * const nic = yield* Azure.Network.NetworkInterface("web-1", {
 *   ipConfigurations: [
 *     {
 *       subnetId: subnet.subnetId,
 *       loadBalancerBackendAddressPoolIds: [lb.backendAddressPoolIds.web],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Two load-balanced VMs
 * ```typescript
 * for (const n of [1, 2]) {
 *   const nic = yield* Azure.Network.NetworkInterface(`web-${n}`, {
 *     ipConfigurations: [
 *       {
 *         subnetId: subnet.subnetId,
 *         loadBalancerBackendAddressPoolIds: [lb.backendAddressPoolIds.web],
 *       },
 *     ],
 *   });
 *   yield* Azure.Compute.VirtualMachine(`web-${n}`, {
 *     vmSize: "Standard_B1s",
 *     networkInterfaceIds: [nic.networkInterfaceId],
 *     adminUsername: "azureuser",
 *     sshPublicKeys: ["ssh-ed25519 AAAAC3Nza... me@example.com"],
 *   });
 * }
 * ```
 *
 * **Example:** IP-based backend pool
 * ```typescript
 * yield* Azure.Network.LoadBalancerBackendAddressPool("web-ips", {
 *   loadBalancer: lb.loadBalancerName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 *   addresses: [{ name: "web1", ipAddress: "10.0.1.4" }],
 * });
 * ```
 *
 * ### Inbound NAT Rules
 * An inbound NAT rule forwards one frontend port to one VM, e.g. for SSH.
 * Declare it with `Azure.Network.InboundNatRule` and attach it to the
 * NIC.
 *
 * **Example:** SSH to one VM on port 50022
 * ```typescript
 * const ssh = yield* Azure.Network.InboundNatRule("web-1-ssh", {
 *   loadBalancer: lb.loadBalancerName,
 *   frontendIpConfiguration: "public",
 *   protocol: "Tcp",
 *   frontendPort: 50022,
 *   backendPort: 22,
 * });
 * const nic = yield* Azure.Network.NetworkInterface("web-1", {
 *   ipConfigurations: [
 *     {
 *       subnetId: subnet.subnetId,
 *       loadBalancerInboundNatRuleIds: [ssh.inboundNatRuleId],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const LoadBalancer = GroupedResource<LoadBalancer>("Azure.Network.LoadBalancer");

type Observed = network.GetLoadBalancerResponse;

const getLb = (subscriptionId: string, resourceGroupName: string, loadBalancerName: string) =>
  orUndefinedIfNotFound(
    network.GetLoadBalancer({
      subscriptionId,
      resourceGroupName,
      loadBalancerName,
    }),
  );

const byName = (
  items: ReadonlyArray<{ name?: string; id?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (items ?? []).flatMap((item) =>
      item.name === undefined || item.id === undefined ? [] : [[item.name, item.id]],
    ),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  lb: Observed,
): LoadBalancer["Attributes"] => ({
  loadBalancerName: name,
  loadBalancerId: lb.id ?? "",
  resourceGroup,
  location: lb.location ?? "",
  sku: lb.sku?.name ?? "",
  tier: lb.sku?.tier ?? "",
  frontendIpConfigurationIds: byName(lb.properties?.frontendIPConfigurations),
  frontendPrivateIpAddresses: Object.fromEntries(
    (lb.properties?.frontendIPConfigurations ?? []).flatMap((frontend) =>
      frontend.name === undefined || frontend.properties?.privateIPAddress === undefined
        ? []
        : [[frontend.name, frontend.properties.privateIPAddress]],
    ),
  ),
  backendAddressPoolIds: byName(lb.properties?.backendAddressPools),
  probeIds: byName(lb.properties?.probes),
  tags: userTags(lb.tags),
});

/** Sort a comparable collection by name so ordering never causes a PUT. */
const sortByName = <T extends { name: string | undefined }>(items: ReadonlyArray<T>) =>
  [...items].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

const lowerSorted = (values: ReadonlyArray<string | undefined> | undefined) =>
  (values ?? []).flatMap((value) => (value === undefined ? [] : [value.toLowerCase()])).sort();

/**
 * Comparable projection of the user-managed collections. Observed values
 * fall back to Azure's defaults so an unchanged load balancer compares
 * equal to its props.
 */
const comparableDesired = (lbId: string, news: LoadBalancerProps) => {
  const sub = (kind: string, child: string) => `${lbId}/${kind}/${child}`.toLowerCase();
  return {
    frontends: sortByName(
      news.frontendIpConfigurations.map((frontend) => ({
        name: frontend.name,
        publicIp: lower(frontend.publicIpAddressId),
        prefix: lower(frontend.publicIpPrefixId),
        subnet: lower(frontend.subnetId),
        allocation:
          frontend.subnetId === undefined
            ? undefined
            : frontend.privateIpAddress === undefined
              ? "Dynamic"
              : "Static",
        privateIp: frontend.privateIpAddress,
        zones: frontend.zones === undefined ? undefined : lowerSorted(frontend.zones),
      })),
    ),
    pools: lowerSorted((news.backendAddressPools ?? []).map((p) => p.name)),
    probes: sortByName(
      (news.probes ?? []).map((probe) => ({
        name: probe.name,
        protocol: probe.protocol,
        port: probe.port,
        requestPath: probe.requestPath,
        interval: probe.intervalInSeconds ?? 5,
        threshold: probe.probeThreshold ?? 1,
      })),
    ),
    rules: sortByName(
      (news.loadBalancingRules ?? []).map((rule) => ({
        name: rule.name,
        frontend: sub("frontendIPConfigurations", rule.frontendIpConfiguration),
        pool:
          rule.backendAddressPool === undefined
            ? undefined
            : sub("backendAddressPools", rule.backendAddressPool),
        probe: rule.probe === undefined ? undefined : sub("probes", rule.probe),
        protocol: rule.protocol,
        frontendPort: rule.frontendPort,
        backendPort: rule.backendPort ?? rule.frontendPort,
        idle: rule.idleTimeoutInMinutes ?? 4,
        floating: rule.enableFloatingIP ?? false,
        tcpReset: rule.enableTcpReset ?? false,
        noSnat: rule.disableOutboundSnat ?? false,
        distribution: rule.loadDistribution ?? "Default",
      })),
    ),
    outbound: sortByName(
      (news.outboundRules ?? []).map((rule) => ({
        name: rule.name,
        frontends: lowerSorted(
          rule.frontendIpConfigurations.map((frontend) =>
            sub("frontendIPConfigurations", frontend),
          ),
        ),
        pool: sub("backendAddressPools", rule.backendAddressPool),
        protocol: rule.protocol,
        ports: rule.allocatedOutboundPorts ?? 0,
        tcpReset: rule.enableTcpReset ?? false,
        idle: rule.idleTimeoutInMinutes ?? 4,
      })),
    ),
  };
};

const comparableObserved = (lb: Observed, news: LoadBalancerProps) => {
  const p = lb.properties;
  // Zones are compared only where declared; Azure may pick a default.
  const zonesDeclared = (name: string | undefined) =>
    news.frontendIpConfigurations.some(
      (frontend) => sameId(frontend.name, name) && frontend.zones !== undefined,
    );
  return {
    frontends: sortByName(
      (p?.frontendIPConfigurations ?? []).map((frontend) => {
        const f = frontend.properties;
        const internal = f?.subnet?.id !== undefined;
        return {
          name: frontend.name,
          publicIp: lower(f?.publicIPAddress?.id),
          prefix: lower(f?.publicIPPrefix?.id),
          subnet: lower(f?.subnet?.id),
          allocation: internal ? (f?.privateIPAllocationMethod ?? "Dynamic") : undefined,
          privateIp:
            internal && f?.privateIPAllocationMethod === "Static" ? f.privateIPAddress : undefined,
          zones: zonesDeclared(frontend.name) ? lowerSorted(frontend.zones) : undefined,
        };
      }),
    ),
    pools: lowerSorted((p?.backendAddressPools ?? []).map((pool) => pool.name)),
    probes: sortByName(
      (p?.probes ?? []).map((probe) => ({
        name: probe.name,
        protocol: probe.properties?.protocol,
        port: probe.properties?.port,
        requestPath: probe.properties?.requestPath,
        interval: probe.properties?.intervalInSeconds ?? 5,
        threshold: probe.properties?.probeThreshold ?? 1,
      })),
    ),
    rules: sortByName(
      (p?.loadBalancingRules ?? []).map((rule) => {
        const r = rule.properties;
        return {
          name: rule.name,
          frontend: lower(r?.frontendIPConfiguration?.id),
          pool: lower(r?.backendAddressPool?.id),
          probe: lower(r?.probe?.id),
          protocol: r?.protocol,
          frontendPort: r?.frontendPort,
          backendPort: r?.backendPort,
          idle: r?.idleTimeoutInMinutes ?? 4,
          floating: r?.enableFloatingIP ?? false,
          tcpReset: r?.enableTcpReset ?? false,
          noSnat: r?.disableOutboundSnat ?? false,
          distribution: r?.loadDistribution ?? "Default",
        };
      }),
    ),
    outbound: sortByName(
      (p?.outboundRules ?? []).map((rule) => {
        const r = rule.properties;
        return {
          name: rule.name,
          frontends: lowerSorted(r?.frontendIPConfigurations?.map((frontend) => frontend.id)),
          pool: lower(r?.backendAddressPool?.id),
          protocol: r?.protocol,
          ports: r?.allocatedOutboundPorts ?? 0,
          tcpReset: r?.enableTcpReset ?? false,
          idle: r?.idleTimeoutInMinutes ?? 4,
        };
      }),
    ),
  };
};

/** Re-encode an observed inbound NAT rule (managed elsewhere) as input. */
const natRuleInput = (rule: network.InboundNatRule): network.InboundNatRuleInput => {
  const p = rule.properties;
  return {
    id: rule.id,
    name: rule.name,
    properties: p && {
      frontendIPConfiguration: ref(p.frontendIPConfiguration?.id),
      protocol: p.protocol,
      frontendPort: p.frontendPort,
      backendPort: p.backendPort,
      idleTimeoutInMinutes: p.idleTimeoutInMinutes,
      enableFloatingIP: p.enableFloatingIP,
      enableTcpReset: p.enableTcpReset,
      frontendPortRangeStart: p.frontendPortRangeStart,
      frontendPortRangeEnd: p.frontendPortRangeEnd,
      backendAddressPool: ref(p.backendAddressPool?.id),
    },
  };
};

export const LoadBalancerProvider = () =>
  Provider.succeed(LoadBalancer, {
    stables: ["loadBalancerName", "loadBalancerId", "resourceGroup", "location", "sku", "tier"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(network.ListLoadBalancerAll, { subscriptionId });
      return page.value.flatMap((lb) => {
        const group = resourceGroupOf(lb.id);
        return hasAnyAlchemyTag(lb.tags) && group !== undefined && lb.name !== undefined
          ? [toAttrs(group, lb.name, lb)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.loadBalancerName)) ||
        (news.location !== undefined && !sameId(news.location, output.location)) ||
        (news.sku ?? "Standard") !== output.sku ||
        (news.tier ?? "Regional") !== output.tier
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.loadBalancerName ?? olds?.name ?? (yield* createNetworkName(id));
      const observed = yield* getLb(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news: declared, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = declared.resourceGroup;
      const name = declared.name ?? output?.loadBalancerName ?? (yield* createNetworkName(id));
      const location = declared.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, declared.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        loadBalancerName: name,
      };
      const get = getLb(subscriptionId, resourceGroup, name);
      // Child references are ARM IDs under the (deterministic) LB ID.
      const lbId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/loadBalancers/${name}`;
      const sub = (kind: string, child: string) => ({
        id: `${lbId}/${kind}/${child}`,
      });

      // Observe.
      let observed = yield* get;
      const props = observed?.properties;

      // Pools this LB never declared (e.g. LoadBalancerBackendAddressPool
      // resources) are preserved; pools it used to declare are removed.
      const ownedPools = [
        ...(declared.backendAddressPools ?? []),
        ...(olds?.backendAddressPools ?? []),
      ].map((pool) => pool.name.toLowerCase());
      const news: LoadBalancerProps = {
        ...declared,
        backendAddressPools: [
          ...(declared.backendAddressPools ?? []),
          ...(props?.backendAddressPools ?? []).flatMap((pool) =>
            pool.name === undefined || ownedPools.includes(pool.name.toLowerCase())
              ? []
              : [{ name: pool.name }],
          ),
        ],
      };

      // Ensure + sync. The PUT replaces every child collection, so it is
      // sent only on drift and carries observed inbound NAT rules and
      // IP-based pool members that are managed elsewhere.
      const differs =
        observed === undefined ||
        canonical(comparableObserved(observed, news)) !== canonical(comparableDesired(lbId, news));
      if (differs) {
        const observedPools = props?.backendAddressPools ?? [];
        yield* network
          .LoadBalancersCreateOrUpdate({
            ...where,
            location,
            tags,
            sku: {
              name: news.sku ?? "Standard",
              tier: news.tier ?? "Regional",
            },
            properties: {
              frontendIPConfigurations: news.frontendIpConfigurations.map((frontend) => ({
                name: frontend.name,
                zones: frontend.zones,
                properties: {
                  publicIPAddress: ref(frontend.publicIpAddressId),
                  publicIPPrefix: ref(frontend.publicIpPrefixId),
                  subnet: ref(frontend.subnetId),
                  privateIPAddress: frontend.privateIpAddress,
                  privateIPAllocationMethod:
                    frontend.subnetId === undefined
                      ? undefined
                      : frontend.privateIpAddress === undefined
                        ? "Dynamic"
                        : "Static",
                  privateIPAddressVersion:
                    frontend.subnetId === undefined
                      ? undefined
                      : (frontend.privateIpAddressVersion ?? "IPv4"),
                },
              })),
              backendAddressPools: (news.backendAddressPools ?? []).map((pool) => {
                const existing = observedPools.find((o) => sameId(o.name, pool.name))?.properties;
                const addresses = (existing?.loadBalancerBackendAddresses ?? []).filter(
                  (address) => address.properties?.networkInterfaceIPConfiguration === undefined,
                );
                return {
                  name: pool.name,
                  properties:
                    addresses.length > 0
                      ? {
                          loadBalancerBackendAddresses: addresses.map((address) => ({
                            name: address.name,
                            properties: {
                              ipAddress: address.properties?.ipAddress,
                              virtualNetwork: ref(address.properties?.virtualNetwork?.id),
                              subnet: ref(address.properties?.subnet?.id),
                              loadBalancerFrontendIPConfiguration: ref(
                                address.properties?.loadBalancerFrontendIPConfiguration?.id,
                              ),
                              adminState: address.properties?.adminState,
                            },
                          })),
                        }
                      : undefined,
                };
              }),
              probes: (news.probes ?? []).map((probe) => ({
                name: probe.name,
                properties: {
                  protocol: probe.protocol,
                  port: probe.port,
                  requestPath: probe.requestPath,
                  intervalInSeconds: probe.intervalInSeconds ?? 5,
                  probeThreshold: probe.probeThreshold ?? 1,
                },
              })),
              loadBalancingRules: (news.loadBalancingRules ?? []).map((rule) => ({
                name: rule.name,
                properties: {
                  frontendIPConfiguration: sub(
                    "frontendIPConfigurations",
                    rule.frontendIpConfiguration,
                  ),
                  backendAddressPool:
                    rule.backendAddressPool === undefined
                      ? undefined
                      : sub("backendAddressPools", rule.backendAddressPool),
                  probe: rule.probe === undefined ? undefined : sub("probes", rule.probe),
                  protocol: rule.protocol,
                  frontendPort: rule.frontendPort,
                  backendPort: rule.backendPort ?? rule.frontendPort,
                  idleTimeoutInMinutes: rule.idleTimeoutInMinutes ?? 4,
                  enableFloatingIP: rule.enableFloatingIP ?? false,
                  enableTcpReset: rule.enableTcpReset ?? false,
                  disableOutboundSnat: rule.disableOutboundSnat ?? false,
                  loadDistribution: rule.loadDistribution ?? "Default",
                },
              })),
              outboundRules: (news.outboundRules ?? []).map((rule) => ({
                name: rule.name,
                properties: {
                  frontendIPConfigurations: rule.frontendIpConfigurations.map((frontend) =>
                    sub("frontendIPConfigurations", frontend),
                  ),
                  backendAddressPool: sub("backendAddressPools", rule.backendAddressPool),
                  protocol: rule.protocol,
                  allocatedOutboundPorts: rule.allocatedOutboundPorts,
                  enableTcpReset: rule.enableTcpReset ?? false,
                  idleTimeoutInMinutes: rule.idleTimeoutInMinutes ?? 4,
                },
              })),
              inboundNatRules: props?.inboundNatRules?.map(natRuleInput),
            },
          })
          .pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed?.tags, tags)) {
        yield* network
          .UpdateLoadBalancerTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(`load balancer ${name}`, get);
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteLoadBalancer({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          loadBalancerName: output.loadBalancerName,
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGone(
        `load balancer ${output.loadBalancerName}`,
        getLb(subscriptionId, output.resourceGroup, output.loadBalancerName),
      );
    }),

    // Delete load balancers before the public IPs and subnets they use.
    nuke: {
      dependsOn: [
        "Azure.Network.PublicIpAddress",
        "Azure.Network.VirtualNetwork",
        "Azure.Network.Subnet",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
