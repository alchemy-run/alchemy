import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findOwnedByName,
  iaasName,
  labelsPatch,
  ownedOnly,
  projectScopeChanged,
  readGeneration,
  resolveProjectScope,
} from "./internal.ts";

/** IPv4 or IPv6 configuration of a {@link Network}. */
export interface NetworkIpConfig {
  /**
   * Prefix of the network in CIDR notation, e.g. `10.0.1.0/24`. Set either
   * `prefix` or `prefixLength`; with neither, STACKIT picks a prefix of the
   * network area's default length. Changing it replaces the network.
   */
  prefix?: string;
  /**
   * Length of the prefix STACKIT allocates from the network area, e.g. `24`.
   * Ignored when `prefix` is set. Changing it replaces the network.
   */
  prefixLength?: number;
  /**
   * Gateway address. `null` creates a network without a gateway; when
   * omitted, STACKIT uses the first address of the prefix and the gateway
   * is not managed. Updated in place.
   */
  gateway?: string | null;
  /**
   * DNS nameservers handed out by DHCP. When omitted, the network area's
   * default nameservers apply and the list is not managed. Updated in place.
   */
  nameservers?: string[];
  /**
   * Id of the VPC network range to allocate the prefix from (VPC projects
   * only). Changing it replaces the network.
   */
  vpcNetworkRangeId?: string;
}

export interface NetworkProps {
  /**
   * Network name: at most 63 characters of letters and digits, separated by
   * single `-`, `_`, `.` or spaces. Updated in place. If omitted, a unique
   * name is generated from the app, stage and logical id.
   */
  name?: string;
  /**
   * Project to create the network in. Defaults to the profile's project.
   * Changing it replaces the network.
   */
  projectId?: string;
  /**
   * Region of the network. Defaults to the profile's region. Changing it
   * replaces the network.
   */
  region?: string;
  /** Free-text description. Updated in place; not managed when omitted. */
  description?: string;
  /**
   * Whether DHCP hands out addresses on the network. Updated in place.
   * @default true
   */
  dhcp?: boolean;
  /** IPv4 configuration. */
  ipv4?: NetworkIpConfig;
  /** IPv6 configuration. Not available for isolated networks. */
  ipv6?: NetworkIpConfig;
  /**
   * Whether the network is routed, i.e. reachable from the other networks
   * of the network area. STACKIT routes networks by default; not managed
   * when omitted. Updated in place.
   */
  routed?: boolean;
  /**
   * Routing table of the network area the network uses (preview routing
   * tables feature). Defaults to the area's default routing table; not
   * managed when omitted. Updated in place.
   */
  routingTableId?: string;
  /**
   * VPC the network belongs to (VPC projects only). Changing it replaces
   * the network.
   */
  vpcId?: string;
  /**
   * Create an isolated network: one that is not connected to the other
   * networks of the project or to the internet (`createIsolatedNetwork`).
   * Only `name`, `dhcp`, `ipv4` and `labels` apply. Changing it replaces
   * the network.
   * @default false
   */
  isolated?: boolean;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface NetworkAttributes {
  /** STACKIT network id (UUID). */
  networkId: string;
  /** Network name. */
  name: string;
  /** Project the network belongs to. */
  projectId: string;
  /** Region of the network. */
  region: string;
  /** Description, if any. */
  description: string | undefined;
  /** Whether DHCP is enabled. */
  dhcp: boolean;
  /** Whether the network is routed. */
  routed: boolean;
  /** Whether the network was created isolated. */
  isolated: boolean;
  /** Routing table the network uses, if reported. */
  routingTableId: string | undefined;
  /** VPC the network belongs to, if any. */
  vpcId: string | undefined;
  /** IPv4 prefixes (CIDR) of the network. */
  ipv4Prefixes: string[];
  /** IPv4 gateway; `undefined` when the network has none. */
  ipv4Gateway: string | undefined;
  /** IPv4 nameservers. */
  ipv4Nameservers: string[];
  /** IPv6 prefixes (CIDR) of the network. */
  ipv6Prefixes: string[];
  /** IPv6 gateway; `undefined` when the network has none. */
  ipv6Gateway: string | undefined;
  /** IPv6 nameservers. */
  ipv6Nameservers: string[];
  /** Public IP of the network's SNAT gateway, when it has internet access. */
  publicIp: string | undefined;
  /** Network status, `CREATED` once ready. */
  status: string;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type Network = Resource<
  "Stackit.IaaS.Network",
  NetworkProps,
  NetworkAttributes,
  never,
  Providers
>;

/**
 * A STACKIT IaaS network: an IPv4 and/or IPv6 prefix in a project, which
 * servers attach to through network interfaces. Networks are allocated
 * from the project's network area (the default public area unless the
 * project is a member of a custom {@link NetworkArea}).
 *
 * Name, description, DHCP, routing, the gateway, nameservers and labels
 * are updated in place. The prefix, the prefix length, the VPC, the
 * project, the region and `isolated` replace the network — and a network
 * cannot be deleted while network interfaces (servers, load balancers)
 * still use it.
 *
 * Creating the first network of a project with internet access may incur
 * cost for the SNAT gateway.
 *
 * ### Creating a network
 * **Example:** Network with a fixed IPv4 prefix
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * ```
 *
 * **Example:** Let STACKIT allocate a /25
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefixLength: 25 },
 * });
 * ```
 *
 * ### Configuring DNS and the gateway
 * **Example:** Custom nameservers and no gateway
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Backend", {
 *   ipv4: {
 *     prefix: "10.0.2.0/24",
 *     gateway: null,
 *     nameservers: ["1.1.1.1", "9.9.9.9"],
 *   },
 *   dhcp: true,
 *   labels: { tier: "backend" },
 * });
 * ```
 *
 * ### Isolated networks
 * **Example:** A network with no route to other networks or the internet
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Sandbox", {
 *   isolated: true,
 *   ipv4: { prefix: "192.168.10.0/24" },
 * });
 * ```
 *
 * ### Replacement
 * Changing `ipv4.prefix`, `ipv4.prefixLength`, the IPv6 equivalents,
 * `vpcId`, `isolated`, `projectId` or `region` creates a new network and
 * deletes the old one. Servers attached to the old network must move first,
 * or the old network's delete fails while its interfaces exist.
 *
 * **Example:** Moving to a new prefix
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Was `10.0.1.0/24`: deploys a new network, then deletes the old one.
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.8.0/24" },
 * });
 * ```
 *
 * @resource
 * @product STACKIT Network
 * @category IaaS
 */
export const Network = Resource<Network>("Stackit.IaaS.Network");

const READY_TIMEOUT = "5 minutes";

const isReady = (network: iaas.Network) => network.status === "CREATED";
const hasFailed = (network: iaas.Network) =>
  network.status === "ERROR" || network.status === "FAILED" ? network.status : undefined;

const toAttrs = (
  network: iaas.Network,
  scope: { projectId: string; region: string },
  isolated: boolean,
): NetworkAttributes => ({
  networkId: network.id,
  name: network.name,
  projectId: scope.projectId,
  region: scope.region,
  description: network.description,
  dhcp: network.dhcp ?? true,
  routed: network.routed ?? false,
  isolated,
  routingTableId: network.routingTableId,
  vpcId: network.vpcId,
  ipv4Prefixes: [...(network.ipv4?.prefixes ?? [])],
  ipv4Gateway: network.ipv4?.gateway ?? undefined,
  ipv4Nameservers: [...(network.ipv4?.nameservers ?? [])],
  ipv6Prefixes: [...(network.ipv6?.prefixes ?? [])],
  ipv6Gateway: network.ipv6?.gateway ?? undefined,
  ipv6Nameservers: [...(network.ipv6?.nameservers ?? [])],
  publicIp: network.ipv4?.publicIp,
  status: network.status,
  labels: stripInternalLabels(network.labels),
});

const getNetwork = (scope: { projectId: string; region: string }, networkId: string) =>
  iaas
    .getNetwork({ projectId: scope.projectId, region: scope.region, networkId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * Whether an observed network can take the desired replace-only props.
 * `isolated` and `vpcNetworkRangeId` can't be observed; the generation label
 * rules out a replaced network instead.
 */
const prefixCompatible = (
  desired: NetworkIpConfig | undefined,
  observed: ReadonlyArray<string> | undefined,
) => {
  if (desired?.prefix !== undefined) return (observed ?? []).includes(desired.prefix);
  if (desired?.prefixLength !== undefined) {
    return (observed ?? []).some((prefix) => prefix.endsWith(`/${desired.prefixLength}`));
  }
  return true;
};

const compatible = (news: NetworkProps) => (network: iaas.Network) =>
  prefixCompatible(news.ipv4, network.ipv4?.prefixes) &&
  prefixCompatible(news.ipv6, network.ipv6?.prefixes) &&
  (news.vpcId === undefined || network.vpcId === news.vpcId);

const observe = Effect.fn(function* (args: {
  id: string;
  name: string;
  scope: { projectId: string; region: string };
  networkId: string | undefined;
  news: NetworkProps | undefined;
  instanceId: string | undefined;
}) {
  if (args.networkId !== undefined) {
    const byId = yield* getNetwork(args.scope, args.networkId);
    if (byId !== undefined) return byId;
  }
  // Crash recovery: a create whose state was never persisted.
  const { items } = yield* iaas.listNetworks({
    projectId: args.scope.projectId,
    region: args.scope.region,
  });
  return yield* findOwnedByName(args.id, args.name, items, {
    instanceId: args.instanceId,
    compatible: args.news === undefined ? undefined : compatible(args.news),
  });
});

const createIpv4 = (config: NetworkIpConfig | undefined): iaas.CreateNetworkIPv4 | undefined => {
  if (config?.prefix !== undefined) {
    return {
      prefix: config.prefix,
      gateway: config.gateway,
      nameservers: config.nameservers,
      vpcNetworkRangeId: config.vpcNetworkRangeId,
    };
  }
  if (config?.prefixLength !== undefined) {
    return {
      prefixLength: config.prefixLength,
      nameservers: config.nameservers,
      vpcNetworkRangeId: config.vpcNetworkRangeId,
    };
  }
  return undefined;
};

const createIpv6 = (config: NetworkIpConfig | undefined): iaas.CreateNetworkIPv6 | undefined =>
  createIpv4(config);

/** The in-place delta of one address family, or `undefined` when it matches. */
const ipPatch = (
  desired: NetworkIpConfig | undefined,
  observed: { gateway?: string | null; nameservers?: ReadonlyArray<string> } | undefined,
): iaas.UpdateNetworkIPv4Body | undefined => {
  if (desired === undefined) return undefined;
  const patch: iaas.UpdateNetworkIPv4Body = {};
  if (desired.gateway !== undefined && desired.gateway !== (observed?.gateway ?? null)) {
    patch.gateway = desired.gateway;
  }
  if (
    desired.nameservers !== undefined &&
    !sameMembers(desired.nameservers, observed?.nameservers)
  ) {
    patch.nameservers = desired.nameservers;
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
};

const ipIdentityChanged = (news: NetworkIpConfig | undefined, olds: NetworkIpConfig | undefined) =>
  news?.prefix !== olds?.prefix ||
  (news?.prefix === undefined && news?.prefixLength !== olds?.prefixLength) ||
  news?.vpcNetworkRangeId !== olds?.vpcNetworkRangeId;

/** The fields of an address family that replace the network when they change. */
const IP_TRIGGERS = ["prefix", "prefixLength", "vpcNetworkRangeId"] as const;

export const NetworkProvider = () =>
  Provider.succeed(Network, {
    stables: ["networkId", "projectId", "region", "isolated"],
    nuke: {
      dependsOn: ["Stackit.IaaS.RoutingTable", "Stackit.IaaS.NetworkAreaRegion"],
    },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listNetworks(scope);
      return ownedOnly(items).map((network) => toAttrs(network, scope, false));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (
        output !== undefined &&
        (hasUnresolvedTrigger<NetworkProps>(news, ["projectId", "region", "isolated", "vpcId"]) ||
          hasUnresolvedTrigger<NetworkIpConfig>(rawProp<NetworkProps>(news, "ipv4"), IP_TRIGGERS) ||
          hasUnresolvedTrigger<NetworkIpConfig>(rawProp<NetworkProps>(news, "ipv6"), IP_TRIGGERS))
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      if ((news.isolated ?? false) !== (output?.isolated ?? olds?.isolated ?? false)) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        if (
          news.vpcId !== olds.vpcId ||
          ipIdentityChanged(news.ipv4, olds.ipv4) ||
          ipIdentityChanged(news.ipv6, olds.ipv6)
        ) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe({
        id,
        name,
        scope,
        networkId: output?.networkId,
        news: olds,
        instanceId: readGeneration({ instanceId, output, previous }),
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope, output?.isolated ?? olds?.isolated ?? false);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const isolated = news.isolated ?? false;
      const resource = `STACKIT network ${name}`;

      // Observe — `output.networkId` is a cache; fall back to this generation's
      // labels + name for a create whose state was never persisted.
      let current = yield* observe({
        id,
        name,
        scope,
        networkId: output?.networkId,
        news,
        instanceId,
      });

      // Ensure — create when missing.
      if (current === undefined) {
        current = isolated
          ? yield* iaas.createIsolatedNetwork({
              projectId: scope.projectId,
              region: scope.region,
              name,
              dhcp: news.dhcp,
              ipv4: createIpv4(news.ipv4),
              labels,
            })
          : yield* iaas.createNetwork({
              projectId: scope.projectId,
              region: scope.region,
              name,
              description: news.description,
              dhcp: news.dhcp,
              ipv4: createIpv4(news.ipv4),
              ipv6: createIpv6(news.ipv6),
              routed: news.routed,
              routingTableId: news.routingTableId,
              vpcId: news.vpcId,
              labels,
            });
      }
      const networkId = current.id;
      const read = iaas.getNetwork({ projectId: scope.projectId, region: scope.region, networkId });
      const waitReady = waitFor({
        resource,
        read,
        ready: isReady,
        failed: hasFailed,
        state: (n) => n.status,
        timeout: READY_TIMEOUT,
      });
      const observed = isReady(current) ? current : yield* waitReady;

      // Sync — diff observed state against desired, patch only the delta.
      const patch: Omit<iaas.PartialUpdateNetworkRequest, "projectId" | "region" | "networkId"> =
        {};
      if (observed.name !== name) patch.name = name;
      if (news.description !== undefined && observed.description !== news.description) {
        patch.description = news.description;
      }
      const dhcp = news.dhcp ?? true;
      if ((observed.dhcp ?? true) !== dhcp) patch.dhcp = dhcp;
      if (!isolated) {
        if (news.routed !== undefined && observed.routed !== news.routed) {
          patch.routed = news.routed;
        }
        if (news.routingTableId !== undefined && observed.routingTableId !== news.routingTableId) {
          patch.routingTableId = news.routingTableId;
        }
        const ipv6 = ipPatch(news.ipv6, observed.ipv6);
        if (ipv6 !== undefined) patch.ipv6 = ipv6;
      }
      const ipv4 = ipPatch(news.ipv4, observed.ipv4);
      if (ipv4 !== undefined) patch.ipv4 = ipv4;
      const labelPatch = labelsPatch(observed.labels, labels);
      if (labelPatch !== undefined) patch.labels = labelPatch;

      let final = observed;
      if (Object.keys(patch).length > 0) {
        yield* iaas.partialUpdateNetwork({
          projectId: scope.projectId,
          region: scope.region,
          networkId,
          ...patch,
        });
        // The update is asynchronous: wait until the network is ready again
        // and reports the patched name and labels.
        final = yield* waitFor({
          resource,
          read,
          ready: (n) => isReady(n) && n.name === name && !labelsChanged(n.labels, labels),
          failed: hasFailed,
          state: (n) => n.status,
          timeout: READY_TIMEOUT,
        });
      }

      return toAttrs(final, scope, isolated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas.deleteNetwork({ ...scope, networkId: output.networkId }).pipe(
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT network ${output.name}`,
        read: getNetwork(scope, output.networkId),
        state: (n) => n.status,
        timeout: READY_TIMEOUT,
      });
    }),
  });
