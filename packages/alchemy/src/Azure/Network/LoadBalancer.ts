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
  /** Availability zones of an internal frontend, e.g. `["1", "2", "3"]`. */
  zones?: string[];
}

export interface LoadBalancerBackendAddressPool {
  /** Name of the pool; rules reference it by this name. */
  name: string;
}

export interface LoadBalancerProbe {
  /** Name of the probe; rules reference it by this name. */
  name: string;
  /** Probe protocol. */
  protocol: "Tcp" | "Http" | "Https";
  /** Port probed on each backend. */
  port: number;
  /** URI probed for `Http` / `Https` probes, e.g. `/healthz`. */
  requestPath?: string;
  /**
   * Seconds between probes.
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
  /** Name of the health probe. */
  probe?: string;
  /** Transport protocol (`All` for HA ports on internal load balancers). */
  protocol: "Tcp" | "Udp" | "All";
  /** Frontend port (0 with `All`). */
  frontendPort: number;
  /**
   * Backend port.
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
  /** SNAT ports allocated per backend instance. */
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
   * SKU. Basic load balancers were retired in 2025. Changing it replaces
   * the load balancer.
   * @default "Standard"
   */
  sku?: "Standard" | "Gateway";
  /**
   * SKU tier: `Regional`, or `Global` for cross-region load balancers.
   * Changing it replaces the load balancer.
   * @default "Regional"
   */
  tier?: "Regional" | "Global";
  /** Frontend IP configurations (public or internal). */
  frontendIpConfigurations: LoadBalancerFrontendIpConfiguration[];
  /**
   * Backend address pools. Network interfaces join a pool through
   * `NetworkInterface.ipConfigurations[].loadBalancerBackendAddressPoolIds`
   * using the IDs in the `backendAddressPoolIds` attribute.
   */
  backendAddressPools?: LoadBalancerBackendAddressPool[];
  /** Health probes. */
  probes?: LoadBalancerProbe[];
  /** Load-balancing rules. */
  loadBalancingRules?: LoadBalancingRule[];
  /** Outbound (SNAT) rules. */
  outboundRules?: LoadBalancerOutboundRule[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
    /** Location of the load balancer. */
    location: string;
    /** SKU name. */
    sku: string;
    /** SKU tier. */
    tier: string;
    /** Frontend IP configuration IDs keyed by name. */
    frontendIpConfigurationIds: Record<string, string>;
    /** Private IPs of internal frontends keyed by frontend name. */
    frontendPrivateIpAddresses: Record<string, string>;
    /** Backend address pool IDs keyed by name. */
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
 * An Azure Load Balancer (Standard SKU) — layer-4 TCP/UDP load balancing
 * for VMs and scale sets, public (internet-facing, through a public IP) or
 * internal (private IP in a subnet).
 *
 * Frontends, backend pools, probes, load-balancing rules, and outbound
 * rules are declared inline and cross-reference each other by name.
 * Inbound NAT rules created outside this resource are preserved.
 *
 * @see https://learn.microsoft.com/azure/load-balancer/load-balancer-overview
 *
 * ### Public Load Balancer
 * **Example:** HTTP load balancer with a health probe
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("lb", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const lb = yield* Azure.Network.LoadBalancer("web", {
 *   resourceGroup: group.resourceGroupName,
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
 * ### Internal Load Balancer
 * **Example:** HA-ports internal load balancer
 * ```typescript
 * const lb = yield* Azure.Network.LoadBalancer("internal", {
 *   resourceGroup: group.resourceGroupName,
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
 * ### Joining the Backend Pool
 * **Example:** Network interface in the backend pool
 * ```typescript
 * const nic = yield* Azure.Network.NetworkInterface("web-1", {
 *   resourceGroup: group.resourceGroupName,
 *   ipConfigurations: [
 *     {
 *       subnetId: subnet.subnetId,
 *       loadBalancerBackendAddressPoolIds: [lb.backendAddressPoolIds.web],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const LoadBalancer = Resource<LoadBalancer>(
  "Azure.Network.LoadBalancer",
);

type Observed = network.GetLoadBalancerResponse;

const getLb = (
  subscriptionId: string,
  resourceGroupName: string,
  loadBalancerName: string,
) =>
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
      item.name === undefined || item.id === undefined
        ? []
        : [[item.name, item.id]],
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
      frontend.name === undefined ||
      frontend.properties?.privateIPAddress === undefined
        ? []
        : [[frontend.name, frontend.properties.privateIPAddress]],
    ),
  ),
  backendAddressPoolIds: byName(lb.properties?.backendAddressPools),
  probeIds: byName(lb.properties?.probes),
  tags: userTags(lb.tags),
});

/** Sort a comparable collection by name so ordering never causes a PUT. */
const sortByName = <T extends { name: string | undefined }>(
  items: ReadonlyArray<T>,
) => [...items].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

const lowerSorted = (values: ReadonlyArray<string | undefined> | undefined) =>
  (values ?? [])
    .flatMap((value) => (value === undefined ? [] : [value.toLowerCase()]))
    .sort();

/**
 * Comparable projection of the user-managed collections. Observed values
 * fall back to Azure's defaults so an unchanged load balancer compares
 * equal to its props.
 */
const comparableDesired = (lbId: string, news: LoadBalancerProps) => {
  const sub = (kind: string, child: string) =>
    `${lbId}/${kind}/${child}`.toLowerCase();
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
        zones:
          frontend.zones === undefined
            ? undefined
            : lowerSorted(frontend.zones),
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
          allocation: internal
            ? (f?.privateIPAllocationMethod ?? "Dynamic")
            : undefined,
          privateIp:
            internal && f?.privateIPAllocationMethod === "Static"
              ? f.privateIPAddress
              : undefined,
          zones: zonesDeclared(frontend.name)
            ? lowerSorted(frontend.zones)
            : undefined,
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
          frontends: lowerSorted(
            r?.frontendIPConfigurations?.map((frontend) => frontend.id),
          ),
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
const natRuleInput = (
  rule: network.InboundNatRule,
): network.InboundNatRuleInput => {
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
    stables: [
      "loadBalancerName",
      "loadBalancerId",
      "resourceGroup",
      "location",
      "sku",
      "tier",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListLoadBalancerAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListLoadBalancerAll", page),
          ),
        );
      return page.value.flatMap((lb) => {
        const group = resourceGroupOf(lb.id);
        return hasAnyAlchemyTag(lb.tags) &&
          group !== undefined &&
          lb.name !== undefined
          ? [toAttrs(group, lb.name, lb)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.loadBalancerName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
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
      const name =
        output?.loadBalancerName ??
        olds?.name ??
        (yield* createNetworkName(id));
      const observed = yield* getLb(subscriptionId, resourceGroup, name);
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
        news.name ?? output?.loadBalancerName ?? (yield* createNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
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

      // Ensure + sync. The PUT replaces every child collection, so it is
      // sent only on drift and carries observed inbound NAT rules and
      // IP-based pool members that are managed elsewhere.
      const differs =
        observed === undefined ||
        canonical(comparableObserved(observed, news)) !==
          canonical(comparableDesired(lbId, news));
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
              frontendIPConfigurations: news.frontendIpConfigurations.map(
                (frontend) => ({
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
                }),
              ),
              backendAddressPools: (news.backendAddressPools ?? []).map(
                (pool) => {
                  const existing = observedPools.find((o) =>
                    sameId(o.name, pool.name),
                  )?.properties;
                  const addresses = (
                    existing?.loadBalancerBackendAddresses ?? []
                  ).filter(
                    (address) =>
                      address.properties?.networkInterfaceIPConfiguration ===
                      undefined,
                  );
                  return {
                    name: pool.name,
                    properties:
                      addresses.length > 0
                        ? {
                            loadBalancerBackendAddresses: addresses.map(
                              (address) => ({
                                name: address.name,
                                properties: {
                                  ipAddress: address.properties?.ipAddress,
                                  virtualNetwork: ref(
                                    address.properties?.virtualNetwork?.id,
                                  ),
                                  subnet: ref(address.properties?.subnet?.id),
                                  loadBalancerFrontendIPConfiguration: ref(
                                    address.properties
                                      ?.loadBalancerFrontendIPConfiguration?.id,
                                  ),
                                  adminState: address.properties?.adminState,
                                },
                              }),
                            ),
                          }
                        : undefined,
                  };
                },
              ),
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
              loadBalancingRules: (news.loadBalancingRules ?? []).map(
                (rule) => ({
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
                    probe:
                      rule.probe === undefined
                        ? undefined
                        : sub("probes", rule.probe),
                    protocol: rule.protocol,
                    frontendPort: rule.frontendPort,
                    backendPort: rule.backendPort ?? rule.frontendPort,
                    idleTimeoutInMinutes: rule.idleTimeoutInMinutes ?? 4,
                    enableFloatingIP: rule.enableFloatingIP ?? false,
                    enableTcpReset: rule.enableTcpReset ?? false,
                    disableOutboundSnat: rule.disableOutboundSnat ?? false,
                    loadDistribution: rule.loadDistribution ?? "Default",
                  },
                }),
              ),
              outboundRules: (news.outboundRules ?? []).map((rule) => ({
                name: rule.name,
                properties: {
                  frontendIPConfigurations: rule.frontendIpConfigurations.map(
                    (frontend) => sub("frontendIPConfigurations", frontend),
                  ),
                  backendAddressPool: sub(
                    "backendAddressPools",
                    rule.backendAddressPool,
                  ),
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
