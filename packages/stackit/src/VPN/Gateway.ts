import * as vpn from "@distilled.cloud/stackit/vpn";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  readGeneration,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { findOwnedGeneration } from "../internal/displayNames.ts";
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import { covers } from "../LoadBalancer/internal.ts";
import type { Providers } from "../Providers.ts";
import {
  GATEWAY_DELETE_TIMEOUT,
  GATEWAY_POLL,
  GATEWAY_READY_TIMEOUT,
  gatewayTunnels,
  generatedName,
  getGatewayOrUndefined,
  listAllGateways,
  listGatewayConnections,
  listGatewayFilters,
  listOwnedGateways,
  requireId,
  STALE_ERROR_POLLS,
  waitForGatewayReady,
} from "./internal.ts";

/** How a gateway routes traffic into its tunnels. */
export type GatewayRoutingType = "POLICY_BASED" | "ROUTE_BASED" | "BGP_ROUTE_BASED";

/** The availability zone of each of a gateway's two tunnels. */
export interface GatewayAvailabilityZones {
  /** Availability zone of the first tunnel, e.g. `eu01-1`. */
  tunnel1: string;
  /** Availability zone of the second tunnel, e.g. `eu01-2`. */
  tunnel2: string;
}

/** BGP settings of a gateway. They apply to all of its connections. */
export interface GatewayBgp {
  /** The gateway's private ASN (RFC 6996): 64512 to 4294967294. */
  localAsn: number;
  /**
   * IPv4 prefixes to advertise, at most 100.
   * @default the network area's ranges
   */
  overrideAdvertisedRoutes?: string[];
}

/** Where a gateway sits in the network area. */
export interface GatewayNetworkConfig {
  /**
   * IPv4 prefix allocated to the gateway, /28 or larger. STACKIT can't change it on a
   * live gateway, so changing it replaces the gateway. Removing the prop keeps the
   * prefix the gateway has.
   */
  predefinedNetworkPrefix?: string;
  /** Id of a custom routing table, e.g. `table.routingTableId`. Updates in place. */
  routingTableId?: string;
}

export interface GatewayProps extends ProjectScopedProps {
  /**
   * Name of the gateway: 1-63 letters, digits and hyphens, starting and ending with a
   * letter or digit. Updates in place.
   * @default a physical name generated from the stack, stage and logical id
   */
  displayName?: string;
  /**
   * Service plan, which sizes the gateway and sets its price, so it has no default:
   * list a region's plans with `ListPlans`. Updates in place.
   */
  planId: string;
  /** The availability zone of each tunnel. Sent as an in-place update when it changes. */
  availabilityZones: GatewayAvailabilityZones;
  /**
   * How the gateway routes traffic. STACKIT can't change it on a live gateway, so
   * changing it replaces the gateway.
   */
  routingType: GatewayRoutingType;
  /** BGP settings, for `BGP_ROUTE_BASED` gateways only. Updates in place. */
  bgp?: GatewayBgp;
  /** Where the gateway sits in the network area. Each field says how it changes. */
  networkConfig?: GatewayNetworkConfig;
  /**
   * User labels, at most 64 including Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`, `alchemy.instance`), which are added automatically.
   * Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * Let a delete take connections and BGP filters this stack doesn't manage with it.
   * Without it, any that remain stop the delete with `Stackit.VPN.GatewayNotEmpty`. Deploy it on
   * its own before a change that replaces the gateway: an old gateway keeps the props it was
   * deployed with.
   * @default false
   */
  forceDestroy?: boolean;
}

/** A gateway's tunnel as `GetGatewayStatus` reports it. */
export interface GatewayTunnel {
  /** `tunnel1` or `tunnel2`. */
  name: string | undefined;
  /** Public IPv4 address of this endpoint. Give it to the remote peer. */
  publicIP: string | undefined;
  /** IPv4 address of this endpoint inside the network area. */
  internalNextHopIP: string | undefined;
}

export interface GatewayAttributes {
  /** STACKIT gateway id (UUID). Stable across updates. */
  gatewayId: string;
  /** Project of the gateway. */
  projectId: string;
  /** Region of the gateway. */
  region: string;
  /** Name of the gateway. */
  displayName: string;
  /** Service plan. */
  planId: string;
  /** How the gateway routes traffic. */
  routingType: GatewayRoutingType;
  /** The availability zone of each tunnel. */
  availabilityZones: GatewayAvailabilityZones;
  /** BGP settings, if any. */
  bgp: GatewayBgp | undefined;
  /** IPv4 prefix STACKIT reports for the gateway, if any. */
  predefinedNetworkPrefix: string | undefined;
  /** Custom routing table, if any. */
  routingTableId: string | undefined;
  /** Gateway state; `READY` after a deploy. */
  state: string | undefined;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
  /** The tunnels, with the public IPs the remote peer has to point at. */
  tunnels: GatewayTunnel[];
}

export type Gateway = Resource<
  "Stackit.VPN.Gateway",
  GatewayProps,
  GatewayAttributes,
  never,
  Providers
>;

/** A gateway holds connections or BGP filters this stack doesn't manage. */
export class GatewayNotEmpty extends Data.TaggedError("Stackit.VPN.GatewayNotEmpty")<{
  readonly gatewayId: string;
  readonly connections: ReadonlyArray<string>;
  readonly bgpFilters: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * A STACKIT VPN gateway: a highly available pair of IPsec endpoints connecting a STACKIT
 * Network Area to an external network, with two tunnels and two public IPs. Connect the
 * remote side with a `Stackit.VPN.Connection`.
 *
 * The project has to sit in a Network Area. A gateway is billed per started hour by its
 * plan, and STACKIT supports neither point-to-site VPN nor NAT on it.
 *
 * Name, plan, availability zones, BGP settings, routing table and labels update in place,
 * which STACKIT documents can renegotiate connections. Deploys wait for `READY`, for up to
 * 45 minutes, and fail with STACKIT's error message when the gateway enters `ERROR`; a later
 * deploy re-submits the configuration. Destroys wait until it is gone, for up to 20 minutes.
 *
 * Ownership is tracked with labels. A gateway found by its explicit `displayName` without
 * them is reported as unowned and only taken over with `--adopt`.
 *
 * ### Creating a Gateway
 * **Example:** A policy-based gateway
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const gateway = yield* Stackit.VPN.Gateway("Office", {
 *   planId: "p100",
 *   routingType: "POLICY_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 * });
 * // gateway.tunnels holds the public IPs to configure on the remote peer.
 * ```
 *
 * **Example:** A route-based gateway on a custom routing table
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const gateway = yield* Stackit.VPN.Gateway("Office", {
 *   displayName: "office-vpn",
 *   planId: "p100",
 *   routingType: "ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   networkConfig: {
 *     predefinedNetworkPrefix: "10.0.0.0/28",
 *     routingTableId: "11111111-1111-4111-8111-111111111111",
 *   },
 *   labels: { team: "netops" },
 * });
 * ```
 *
 * ### Dynamic Routing with BGP
 * **Example:** A gateway advertising its own routes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const gateway = yield* Stackit.VPN.Gateway("Backbone", {
 *   planId: "p500",
 *   routingType: "BGP_ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   bgp: {
 *     localAsn: 64512,
 *     overrideAdvertisedRoutes: ["10.10.0.0/16"],
 *   },
 * });
 * ```
 *
 * ### Deleting a Gateway
 * **Example:** Let a delete take connections this stack doesn't manage
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Deleting a gateway removes its connections too. So a delete first waits up to two
 * // minutes for this stack's own to go, then fails with Stackit.VPN.GatewayNotEmpty,
 * // naming what is left. Only `forceDestroy` and `alchemy unsafe nuke` go past that.
 * const gateway = yield* Stackit.VPN.Gateway("Office", {
 *   planId: "p100",
 *   routingType: "POLICY_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Report tunnel health from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Office = Stackit.VPN.Gateway("Office", {
 *   planId: "p100",
 *   routingType: "POLICY_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getStatus = yield* Stackit.VPN.GetGatewayStatus(yield* Office);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const status = yield* getStatus();
 *         return yield* HttpServerResponse.json({ state: status.gatewayStatus });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetGatewayStatusHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the routing type
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new routing type or prefix replaces the gateway, with new public IPs, and every
 * // connection on it moves to the new one. With a generated name the new gateway comes
 * // up first. With an explicit `displayName` or a kept prefix the old one goes first,
 * // because the spec doesn't say either can be held twice. That delete runs before the
 * // connections are replaced, so while any are attached the plan fails with
 * // Stackit.VPN.GatewayNotEmpty and nothing changes, unless `forceDestroy` was already
 * // deployed: deploy it on its own first, then this.
 * const gateway = yield* Stackit.VPN.Gateway("Office", {
 *   displayName: "office-vpn",
 *   planId: "p100",
 *   routingType: "ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   forceDestroy: true,
 * });
 * ```
 *
 * @resource
 * @product STACKIT VPN
 * @category VPN
 */
export const Gateway = Resource<Gateway>("Stackit.VPN.Gateway");

/**
 * STACKIT's Terraform provider retries `updateGateway` on 409 with these numbers: "the
 * backend may respond with 409s during the update", and the error says to retry later.
 */
const UPDATE_CONFLICT_RETRY = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 6,
} as const;

const toAttrs = (
  scope: ProjectScope,
  gatewayId: string,
  gateway: vpn.GatewayResponse,
  tunnels: GatewayTunnel[],
): GatewayAttributes => ({
  gatewayId,
  ...scope,
  displayName: gateway.displayName,
  planId: gateway.planId,
  routingType: gateway.routingType,
  availabilityZones: {
    tunnel1: gateway.availabilityZones.tunnel1,
    tunnel2: gateway.availabilityZones.tunnel2,
  },
  bgp: gateway.bgp === undefined ? undefined : { ...gateway.bgp },
  predefinedNetworkPrefix: gateway.networkConfig?.predefinedNetworkPrefix,
  routingTableId: gateway.networkConfig?.routingTableId,
  state: gateway.state,
  labels: stripInternalLabels(gateway.labels),
  tunnels,
});

const liveGateways = (scope: ProjectScope) =>
  listAllGateways(scope).pipe(
    Effect.map((gateways) => gateways.filter((gateway) => gateway.state !== "DELETING")),
  );

/** This generation's gateway: only that can be claimed without state. */
const findGeneration = (scope: ProjectScope, id: string, instanceId: string) =>
  Effect.gen(function* () {
    for (const gateway of yield* listAllGateways(scope)) {
      if (
        hasInstanceLabel(instanceId, gateway.labels) &&
        (yield* hasAlchemyLabels(id, gateway.labels))
      ) {
        return gateway;
      }
    }
    return undefined;
  });

const waitForGatewayGone = (scope: ProjectScope, gatewayId: string, startedDeleting: boolean) => {
  // A gateway already in `ERROR` can report it once more before the delete takes hold. Only
  // an error after `DELETING` is a failed delete.
  let sawDeleting = startedDeleting;
  return waitUntilGone({
    resource: `STACKIT VPN gateway ${gatewayId}`,
    read: getGatewayOrUndefined(scope, gatewayId),
    failed: (gateway: vpn.GetGatewayResponse) => {
      if (gateway.state === "DELETING") sawDeleting = true;
      return sawDeleting && gateway.state === "ERROR" ? "the delete failed" : undefined;
    },
    state: (gateway: vpn.GetGatewayResponse) => gateway.state,
    timeout: GATEWAY_DELETE_TIMEOUT,
    ...GATEWAY_POLL,
  });
};

/**
 * Wait for the gateway's children to go, then refuse if any are left. One a destroy deleted
 * is gone by now. What remains is someone else's, or one of this stack that a delete-first
 * replacement of the gateway hasn't reached.
 */
const listChildren = (scope: ProjectScope, gatewayId: string) =>
  Effect.all([listGatewayConnections(scope, gatewayId), listGatewayFilters(scope, gatewayId)]).pipe(
    Effect.map(([connections, filters]) => [
      ...connections.map((connection) => ({
        kind: "connection" as const,
        displayName: connection.displayName,
      })),
      ...filters.map((filter) => ({ kind: "filter" as const, displayName: filter.displayName })),
    ]),
  );

const notEmptyError = (
  gatewayId: string,
  left: ReadonlyArray<{ readonly kind: "connection" | "filter"; readonly displayName: string }>,
  remedy: string,
) => {
  const namesOf = (kind: "connection" | "filter") =>
    left.filter((child) => child.kind === kind).map((child) => child.displayName);
  const connections = namesOf("connection");
  const bgpFilters = namesOf("filter");
  return new GatewayNotEmpty({
    gatewayId,
    connections,
    bgpFilters,
    message: `Gateway ${gatewayId} still has connections [${connections.join(", ")}] and BGP filters [${bgpFilters.join(", ")}]. Deleting it would delete them too. ${remedy}`,
  });
};

const assertNoChildren = (scope: ProjectScope, gatewayId: string) =>
  Effect.gen(function* () {
    const left = yield* childrenLeftAfterSettling(listChildren(scope, gatewayId));
    if (left.length === 0) return;
    return yield* notEmptyError(
      gatewayId,
      left,
      "Delete them first, or deploy forceDestroy: true on the gateway. A gateway already being replaced keeps the props it was deployed with, so only deleting them by hand finishes that replacement.",
    );
  });

/**
 * A delete-first replacement reaches the old gateway before any child in the stack is deleted, so
 * it can't get through while there are children. Say so at plan, before anything is created.
 */
const refuseDeleteFirst = (olds: GatewayProps | undefined, output: GatewayAttributes) =>
  Effect.gen(function* () {
    if (olds?.forceDestroy === true) return;
    const scope = { projectId: output.projectId, region: output.region };
    const left = yield* listChildren(scope, output.gatewayId);
    if (left.length === 0) return;
    return yield* notEmptyError(
      output.gatewayId,
      left,
      "This change deletes the old gateway first, so nothing was changed. Take them out of the stack in a deploy of its own, or deploy forceDestroy: true on the gateway on its own, then make this change.",
    );
  });

export const GatewayProvider = () =>
  Provider.succeed(Gateway, {
    stables: ["gatewayId", "projectId", "region"],
    // Delete order: the gateway goes before the routing table it uses.
    nuke: { dependsOn: ["Stackit.IaaS.RoutingTable"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const gateways = yield* listOwnedGateways(scope);
      const attrs: GatewayAttributes[] = [];
      for (const gateway of gateways) {
        if (gateway.id === undefined) continue;
        const tunnels = yield* gatewayTunnels(scope, gateway.id);
        attrs.push(toAttrs(scope, gateway.id, gateway, tunnels));
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      const displayName = rawProp<GatewayProps>(news, "displayName");
      const network = rawProp<GatewayProps>(news, "networkConfig");
      // The spec doesn't say an explicit name or a prefix can be held twice, and an
      // unresolved one can resolve to what the old gateway holds: delete it first. A
      // generated name carries the generation, so it never collides.
      if (
        hasUnresolvedTrigger<GatewayProps>(news, ["routingType", "projectId", "region"]) ||
        hasUnresolvedTrigger<GatewayNetworkConfig>(network, ["predefinedNetworkPrefix"])
      ) {
        const deleteFirst =
          displayName !== undefined ||
          rawProp<GatewayNetworkConfig>(network, "predefinedNetworkPrefix") !== undefined;
        if (deleteFirst) yield* refuseDeleteFirst(olds, output);
        return { action: "replace", deleteFirst } as const;
      }
      const resolved = triggerProps<GatewayProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const prefix = resolved.networkConfig?.predefinedNetworkPrefix;
      // The previous props first: STACKIT may report a normalized prefix, or one it chose.
      // No prefix in the props asks for nothing, so removing it replaces nothing.
      const prefixChanged =
        prefix !== undefined &&
        prefix !== (olds?.networkConfig?.predefinedNetworkPrefix ?? output.predefinedNetworkPrefix);
      if (scopeChanged || prefixChanged || resolved.routingType !== output.routingType) {
        const keptName =
          displayName !== undefined &&
          (!isResolved(displayName) || displayName === output.displayName);
        const keptPrefix = prefix !== undefined && !prefixChanged;
        const deleteFirst = !scopeChanged && (keptName || keptPrefix);
        if (deleteFirst) yield* refuseDeleteFirst(olds, output);
        return { action: "replace", deleteFirst } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const attrsOf = (gatewayId: string, gateway: vpn.GatewayResponse) =>
        gatewayTunnels(scope, gatewayId).pipe(
          Effect.map((tunnels) => toAttrs(scope, gatewayId, gateway, tunnels)),
        );
      if (output?.gatewayId !== undefined) {
        const byId = yield* getGatewayOrUndefined(scope, output.gatewayId);
        if (byId !== undefined && byId.state !== "DELETING") {
          return yield* attrsOf(output.gatewayId, byId);
        }
      }
      const gateways = yield* liveGateways(scope);
      // A crashed create has neither state nor a previous generation, and any generation of
      // this logical id is ours. A replacement only owns its own.
      const owned = yield* findOwnedGeneration(
        id,
        readGeneration({ instanceId, output, previous }),
        gateways,
        (gateway) => gateway.labels,
      );
      if (owned?.id !== undefined) return yield* attrsOf(owned.id, owned);
      if (olds?.displayName === undefined) return undefined;
      // A display name found twice is evidently no identity, so it claims nothing.
      const named = gateways.filter((gateway) => gateway.displayName === olds.displayName);
      const found = named.length === 1 ? named[0] : undefined;
      if (found?.id === undefined) return undefined;
      const attrs = yield* attrsOf(found.id, found);
      const isPrevious =
        previous?.gatewayId === found.id &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const displayName = news.displayName ?? output?.displayName ?? (yield* generatedName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const routingTableId = news.networkConfig?.routingTableId;

      // 1. Observe — `output` is a cache for the id, and only names the desired gateway
      // while it sits in the same project and region. Without it, only this generation's
      // gateway can be claimed.
      let current: vpn.GatewayResponse | undefined =
        output?.gatewayId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* getGatewayOrUndefined(scope, output.gatewayId)
          : undefined;
      current ??= yield* findGeneration(scope, id, instanceId);
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "DELETING") {
        const deleting = yield* requireId(`gateway ${displayName}`, current.id);
        yield* waitForGatewayGone(scope, deleting, true);
        current = undefined;
      }

      // 2. Ensure — a 409 may be our own create racing, so look again before failing.
      if (current === undefined) {
        current = yield* vpn
          .createGateway({
            ...scope,
            displayName,
            planId: news.planId,
            routingType: news.routingType,
            availabilityZones: news.availabilityZones,
            bgp: news.bgp,
            networkConfig: news.networkConfig,
            labels,
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              findGeneration(scope, id, instanceId).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
      }
      const gatewayId = yield* requireId(`gateway ${displayName}`, current.id);

      // Wait out an in-flight create or update before comparing against it. A gateway in
      // `ERROR` isn't failed here: the sync below re-submits the configuration, which may
      // repair it.
      const settled =
        current.state === "READY" || current.state === "ERROR"
          ? current
          : yield* waitFor({
              resource: `STACKIT VPN gateway ${displayName}`,
              read: vpn.getGateway({ ...scope, gatewayId }),
              ready: (gateway) => gateway.state === "READY" || gateway.state === "ERROR",
              failed: (gateway) =>
                gateway.state === "DELETING" ? "it is being deleted" : undefined,
              state: (gateway) => gateway.state,
              timeout: GATEWAY_READY_TIMEOUT,
              ...GATEWAY_POLL,
            });

      // 3. Sync — the API has one full-body update, so one diff decides it. Observed state
      // can't show a field the user removed, since `covers` ignores what the props leave
      // out, so the previous props flag that.
      const inSync =
        settled.displayName === displayName &&
        settled.planId === news.planId &&
        settled.availabilityZones.tunnel1 === news.availabilityZones.tunnel1 &&
        settled.availabilityZones.tunnel2 === news.availabilityZones.tunnel2 &&
        covers(news.bgp, settled.bgp) &&
        (routingTableId === undefined ||
          settled.networkConfig?.routingTableId === routingTableId) &&
        !labelsChanged(settled.labels, labels);
      const declarationChanged =
        olds !== undefined &&
        (JSON.stringify(olds.bgp) !== JSON.stringify(news.bgp) ||
          olds.networkConfig?.routingTableId !== routingTableId);

      // 4. Return, when there is nothing to change.
      if (settled.state !== "ERROR" && !declarationChanged && inSync) {
        const tunnels = yield* gatewayTunnels(scope, gatewayId);
        return toAttrs(scope, gatewayId, settled, tunnels);
      }

      yield* vpn.getGateway({ ...scope, gatewayId }).pipe(
        Effect.flatMap((live) => {
          const keptRoutingTable =
            routingTableId ??
            (olds?.networkConfig?.routingTableId !== undefined
              ? undefined
              : live.networkConfig?.routingTableId);
          // Not changeable, but the update takes the full resource.
          const keptPrefix = live.networkConfig?.predefinedNetworkPrefix;
          return vpn.updateGateway({
            ...scope,
            gatewayId,
            displayName,
            planId: news.planId,
            routingType: live.routingType,
            availabilityZones: news.availabilityZones,
            bgp: news.bgp,
            networkConfig:
              keptRoutingTable === undefined && keptPrefix === undefined
                ? undefined
                : { predefinedNetworkPrefix: keptPrefix, routingTableId: keptRoutingTable },
            labels,
          });
        }),
        Effect.retry(UPDATE_CONFLICT_RETRY),
      );
      const ready = yield* waitForGatewayReady(scope, gatewayId, {
        staleErrors: settled.state === "ERROR" ? STALE_ERROR_POLLS : 0,
      });
      const tunnels = yield* gatewayTunnels(scope, gatewayId);
      return toAttrs(scope, gatewayId, ready, tunnels);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { gatewayId } = output;
      const current = yield* getGatewayOrUndefined(scope, gatewayId);
      if (current === undefined) return;
      if (current.state !== "DELETING") {
        // The API removes a gateway's connections with it, and those may not be ours, so
        // that takes an opt-in: the prop, or `alchemy unsafe nuke`.
        if (olds?.forceDestroy !== true && force !== true) {
          yield* assertNoChildren(scope, gatewayId);
        }
        yield* vpn.deleteGateway({ ...scope, gatewayId });
      }
      yield* waitForGatewayGone(scope, gatewayId, current.state === "DELETING");
    }),
  });
