import * as vpn from "@distilled.cloud/stackit/vpn";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
import { secretsDiffer } from "../internal/equal.ts";
import { waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import { covers } from "../LoadBalancer/internal.ts";
import type { Providers } from "../Providers.ts";
import {
  generatedName,
  listGatewayConnections,
  listOwnedGateways,
  requireId,
  settleGateway,
  withGatewayConnectionLock,
  STALE_ERROR_POLLS,
  waitForGatewayReady,
} from "./internal.ts";

/** A Diffie-Hellman group of an IPsec phase. */
export type ConnectionDhGroup = "modp1024" | "modp2048" | "ecp256" | "ecp384" | "modp2048s256";

/** An encryption algorithm of an IPsec phase. */
export type ConnectionEncryptionAlgorithm = "aes256" | "aes128gcm16" | "aes256gcm16";

/** An integrity algorithm of an IPsec phase. STACKIT removes `sha1` on 2026-12-31. */
export type ConnectionIntegrityAlgorithm = "sha1" | "sha2_256" | "sha2_384" | "sha2_512";

/** The IKE settings of a tunnel. */
export interface ConnectionPhase1 {
  /** Encryption algorithms to offer. */
  encryptionAlgorithms: ConnectionEncryptionAlgorithm[];
  /** Integrity algorithms to offer. */
  integrityAlgorithms: ConnectionIntegrityAlgorithm[];
  /** Diffie-Hellman groups to offer. Required unless the algorithms are AEAD ones. */
  dhGroups?: ConnectionDhGroup[];
  /**
   * Seconds until an IKE re-key, 900 to 86400.
   * @default 14400
   */
  rekeyTime?: number;
}

/** The IPsec settings of a tunnel. */
export interface ConnectionPhase2 {
  /** Encryption algorithms to offer. */
  encryptionAlgorithms: ConnectionEncryptionAlgorithm[];
  /** Integrity algorithms to offer. */
  integrityAlgorithms: ConnectionIntegrityAlgorithm[];
  /** Diffie-Hellman groups to offer. Required unless the algorithms are AEAD ones. */
  dhGroups?: ConnectionDhGroup[];
  /**
   * What to do on a dead-peer timeout: `clear` closes the tunnel, `restart` negotiates a
   * new one at once.
   * @default "restart"
   */
  dpdAction?: "clear" | "restart";
  /**
   * What to do once the configuration is loaded: `start` initiates the tunnel, `none`
   * waits for it to be initiated.
   * @default "start"
   */
  startAction?: "none" | "start";
  /**
   * Seconds until an IPsec re-key, 900 to 14400.
   * @default 3600
   */
  rekeyTime?: number;
}

/** The BGP settings of a tunnel. */
export interface ConnectionTunnelBgp {
  /** ASN of the remote neighbor. */
  remoteAsn: number;
  /**
   * Id of a `Stackit.VPN.BGPFilter` on the same gateway for routes from this neighbor,
   * e.g. `filter.filterId`. Tunnels may share a filter.
   */
  inboundFilterId?: string;
}

/** The point-to-point addresses of a tunnel interface. */
export interface ConnectionTunnelPeering {
  /** IPv4 address on STACKIT's side. */
  localAddress?: string;
  /** IPv4 address on the remote side. */
  remoteAddress?: string;
}

/** One of a connection's two tunnels. */
export interface ConnectionTunnel {
  /** IPv4 address of the remote endpoint. */
  remoteAddress: string;
  /**
   * The shared secret, at least 20 characters. STACKIT never returns it, so Alchemy can't
   * see what is deployed: it sends the key on create, and later only when this prop
   * changes. It is kept out of the attributes.
   */
  preSharedKey: string | Redacted.Redacted<string>;
  /** IKE settings. */
  phase1: ConnectionPhase1;
  /** IPsec settings. */
  phase2: ConnectionPhase2;
  /** BGP settings, on a `BGP_ROUTE_BASED` gateway. */
  bgp?: ConnectionTunnelBgp;
  /** Point-to-point addresses, for BGP peering and static route next hops. */
  peering?: ConnectionTunnelPeering;
}

export interface ConnectionProps extends ProjectScopedProps {
  /** Id of the gateway, e.g. `gateway.gatewayId`. Changing it replaces the connection. */
  gatewayId: string;
  /**
   * Name of the connection: 1-63 letters, digits and hyphens, starting and ending with a
   * letter or digit. Updates in place.
   * @default a physical name generated from the stack, stage and logical id
   */
  displayName?: string;
  /**
   * Whether the connection is up. Updates in place.
   * @default true
   */
  enabled?: boolean;
  /**
   * Local networks, at most 100. Required on a `POLICY_BASED` gateway; STACKIT documents a
   * default of `0.0.0.0/0` on route-based ones. Updates in place.
   */
  localSubnets?: string[];
  /**
   * Remote networks, at most 100. Required on a `POLICY_BASED` gateway; STACKIT documents
   * a default of `0.0.0.0/0` on route-based ones. Updates in place.
   */
  remoteSubnets?: string[];
  /** Networks to route into the tunnels, on a `ROUTE_BASED` gateway. Updates in place. */
  staticRoutes?: string[];
  /** The first tunnel. Updates in place. */
  tunnel1: ConnectionTunnel;
  /** The second tunnel. Updates in place. */
  tunnel2: ConnectionTunnel;
  /**
   * User labels, at most 64 including Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`, `alchemy.instance`), which are added automatically.
   * Updates in place.
   */
  labels?: Record<string, string>;
}

/** A tunnel as STACKIT reports it: the pre-shared key is never part of it. */
export type ConnectionTunnelAttributes = vpn.TunnelConfigurationOutput;

export interface ConnectionAttributes {
  /** STACKIT connection id (UUID). Stable across updates. */
  connectionId: string;
  /** Id of the gateway. */
  gatewayId: string;
  /** Project of the gateway. */
  projectId: string;
  /** Region of the gateway. */
  region: string;
  /** Name of the connection. */
  displayName: string;
  /** Whether the connection is up. */
  enabled: boolean;
  /** Local networks. */
  localSubnets: string[];
  /** Remote networks. */
  remoteSubnets: string[];
  /** Static routes. */
  staticRoutes: string[];
  /** The first tunnel, without its key. */
  tunnel1: ConnectionTunnelAttributes;
  /** The second tunnel, without its key. */
  tunnel2: ConnectionTunnelAttributes;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type Connection = Resource<
  "Stackit.VPN.Connection",
  ConnectionProps,
  ConnectionAttributes,
  never,
  Providers
>;

/**
 * A STACKIT VPN connection: the IPsec settings of a `Stackit.VPN.Gateway` towards one remote
 * peer, with two tunnels for redundancy.
 *
 * A deploy waits for the gateway to reach `READY`, never for the tunnels to come up, because
 * that depends on the remote peer. Read the tunnels' state with `GetConnectionStatus`.
 *
 * STACKIT never returns a pre-shared key, so changing one on the portal goes unnoticed; change
 * `preSharedKey` here to rotate it. Keys stay out of the attributes, but the props, and so the
 * key, are kept in the state store, like every other Redacted prop.
 *
 * Everything but the gateway updates in place. Ownership is tracked with labels. A connection
 * found by its explicit `displayName` on the gateway without them is reported as unowned and
 * only taken over with `--adopt`.
 *
 * See [STACKIT's VPN docs](https://docs.stackit.cloud/products/network/connectivity-hybrid-multi-cloud/vpn/).
 *
 * :::caution[Changing `gatewayId`, `projectId` or `region` replaces the Connection]
 * The connection is created on the new gateway and the old one is deleted. Point the
 * remote peer at the new gateway's public IPs.
 * :::
 *
 * ### Creating a Connection
 * **Example:** A policy-based connection
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const preSharedKey = Config.Redacted("VPN_PRE_SHARED_KEY");
 * const gateway = yield* Stackit.VPN.Gateway("Office", {
 *   planId: "p100",
 *   routingType: "POLICY_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 * });
 * const phase = {
 *   encryptionAlgorithms: ["aes256" as const],
 *   integrityAlgorithms: ["sha2_384" as const],
 *   dhGroups: ["ecp384" as const],
 * };
 * const connection = yield* Stackit.VPN.Connection("Berlin", {
 *   gatewayId: gateway.gatewayId,
 *   localSubnets: ["10.0.0.0/16"],
 *   remoteSubnets: ["192.168.0.0/24"],
 *   tunnel1: {
 *     remoteAddress: "203.0.113.10",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *   },
 *   tunnel2: {
 *     remoteAddress: "203.0.113.11",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *   },
 * });
 * ```
 *
 * **Example:** Static routes on a route-based gateway
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const preSharedKey = Config.Redacted("VPN_PRE_SHARED_KEY");
 * const gateway = yield* Stackit.VPN.Gateway("Office", {
 *   planId: "p100",
 *   routingType: "ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 * });
 * const phase = {
 *   encryptionAlgorithms: ["aes256gcm16" as const],
 *   integrityAlgorithms: ["sha2_256" as const],
 * };
 * const connection = yield* Stackit.VPN.Connection("Berlin", {
 *   gatewayId: gateway.gatewayId,
 *   staticRoutes: ["192.168.0.0/24"],
 *   tunnel1: {
 *     remoteAddress: "203.0.113.10",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *     peering: { localAddress: "169.254.10.1", remoteAddress: "169.254.10.2" },
 *   },
 *   tunnel2: {
 *     remoteAddress: "203.0.113.11",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *     peering: { localAddress: "169.254.11.1", remoteAddress: "169.254.11.2" },
 *   },
 * });
 * ```
 *
 * ### Dynamic Routing with BGP
 * **Example:** Tunnels peering over BGP, with a filter on incoming routes
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const preSharedKey = Config.Redacted("VPN_PRE_SHARED_KEY");
 * const gateway = yield* Stackit.VPN.Gateway("Backbone", {
 *   planId: "p100",
 *   routingType: "BGP_ROUTE_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 *   bgp: { localAsn: 64512 },
 * });
 * const filter = yield* Stackit.VPN.BGPFilter("Inbound", {
 *   gatewayId: gateway.gatewayId,
 * });
 * const phase = {
 *   encryptionAlgorithms: ["aes256" as const],
 *   integrityAlgorithms: ["sha2_384" as const],
 *   dhGroups: ["ecp384" as const],
 * };
 * const connection = yield* Stackit.VPN.Connection("Berlin", {
 *   gatewayId: gateway.gatewayId,
 *   tunnel1: {
 *     remoteAddress: "203.0.113.10",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *     bgp: { remoteAsn: 64600, inboundFilterId: filter.filterId },
 *     peering: { localAddress: "169.254.10.1", remoteAddress: "169.254.10.2" },
 *   },
 *   tunnel2: {
 *     remoteAddress: "203.0.113.11",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *     bgp: { remoteAsn: 64600, inboundFilterId: filter.filterId },
 *     peering: { localAddress: "169.254.11.1", remoteAddress: "169.254.11.2" },
 *   },
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Report the tunnels' state from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * const phase = {
 *   encryptionAlgorithms: ["aes256" as const],
 *   integrityAlgorithms: ["sha2_384" as const],
 *   dhGroups: ["ecp384" as const],
 * };
 *
 * export const Berlin = Stackit.VPN.Connection("Berlin", {
 *   gatewayId: "11111111-1111-4111-8111-111111111111",
 *   localSubnets: ["10.0.0.0/16"],
 *   remoteSubnets: ["192.168.0.0/24"],
 *   tunnel1: {
 *     remoteAddress: "203.0.113.10",
 *     preSharedKey: Redacted.make("a-key-of-at-least-20-characters"),
 *     phase1: phase,
 *     phase2: phase,
 *   },
 *   tunnel2: {
 *     remoteAddress: "203.0.113.11",
 *     preSharedKey: Redacted.make("a-key-of-at-least-20-characters"),
 *     phase1: phase,
 *     phase2: phase,
 *   },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getStatus = yield* Stackit.VPN.GetConnectionStatus(yield* Berlin);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const status = yield* getStatus();
 *         return yield* HttpServerResponse.json({
 *           up: (status.tunnels ?? []).filter((tunnel) => tunnel.established).length,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.VPN.GetConnectionStatusHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving a connection to another gateway
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * // A new gateway id replaces the connection, and so does anything replacing the gateway.
 * // With a generated name the new connection comes up first.
 * const preSharedKey = Config.Redacted("VPN_PRE_SHARED_KEY");
 * const gateway = yield* Stackit.VPN.Gateway("OfficeB", {
 *   planId: "p100",
 *   routingType: "POLICY_BASED",
 *   availabilityZones: { tunnel1: "eu01-1", tunnel2: "eu01-2" },
 * });
 * const phase = {
 *   encryptionAlgorithms: ["aes256" as const],
 *   integrityAlgorithms: ["sha2_384" as const],
 *   dhGroups: ["ecp384" as const],
 * };
 * const connection = yield* Stackit.VPN.Connection("Berlin", {
 *   gatewayId: gateway.gatewayId,
 *   localSubnets: ["10.0.0.0/16"],
 *   remoteSubnets: ["192.168.0.0/24"],
 *   tunnel1: {
 *     remoteAddress: "203.0.113.10",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *   },
 *   tunnel2: {
 *     remoteAddress: "203.0.113.11",
 *     preSharedKey,
 *     phase1: phase,
 *     phase2: phase,
 *   },
 * });
 * ```
 *
 * @resource
 * @product STACKIT VPN
 * @category VPN
 */
export const Connection = Resource<Connection>("Stackit.VPN.Connection");

/** Deleting a connection is synchronous in the official clients: this absorbs read lag. */
const CONNECTION_DELETE_TIMEOUT = "2 minutes";

type GatewayScope = ProjectScope & { readonly gatewayId: string };

const getConnectionOrUndefined = (scope: GatewayScope, connectionId: string) =>
  vpn
    .getGatewayConnection({ ...scope, connectionId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (
  scope: GatewayScope,
  connectionId: string,
  connection: vpn.ConnectionResponseOutput,
): ConnectionAttributes => ({
  connectionId,
  ...scope,
  displayName: connection.displayName,
  enabled: connection.enabled ?? true,
  localSubnets: [...(connection.localSubnets ?? [])],
  remoteSubnets: [...(connection.remoteSubnets ?? [])],
  staticRoutes: [...(connection.staticRoutes ?? [])],
  tunnel1: connection.tunnel1,
  tunnel2: connection.tunnel2,
  labels: stripInternalLabels(connection.labels),
});

/** This generation's connection: only that can be claimed without state. */
const findGeneration = (scope: GatewayScope, id: string, instanceId: string) =>
  Effect.gen(function* () {
    const connections = yield* listGatewayConnections(scope, scope.gatewayId);
    for (const connection of connections) {
      if (
        hasInstanceLabel(instanceId, connection.labels) &&
        (yield* hasAlchemyLabels(id, connection.labels))
      ) {
        return connection;
      }
    }
    return undefined;
  });

const withoutKey = ({ preSharedKey: _preSharedKey, ...tunnel }: ConnectionTunnel) => tunnel;

/** Everything of a connection `olds` can flag, with the keys left out. */
const declaration = (props: ConnectionProps) => ({
  localSubnets: props.localSubnets,
  remoteSubnets: props.remoteSubnets,
  staticRoutes: props.staticRoutes,
  tunnel1: withoutKey(props.tunnel1),
  tunnel2: withoutKey(props.tunnel2),
});

/**
 * A tunnel for the update body. The API keeps a key the update leaves out, so a key goes
 * out only when `olds` says it changed, or when there are no `olds` to say: an adopted
 * connection has an unknown key.
 */
const tunnelToUpdate = (desired: ConnectionTunnel, previous: ConnectionTunnel | undefined) =>
  previous === undefined || secretsDiffer(desired.preSharedKey, previous.preSharedKey)
    ? desired
    : withoutKey(desired);

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: ["connectionId", "gatewayId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.VPN.Gateway", "Stackit.VPN.BGPFilter"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectScope = { projectId: env.projectId, region: env.region };
      const gateways = yield* listOwnedGateways(projectScope);
      const attrs: ConnectionAttributes[] = [];
      for (const gateway of gateways) {
        if (gateway.id === undefined) continue;
        const scope = { ...projectScope, gatewayId: gateway.id };
        const connections = yield* listGatewayConnections(projectScope, gateway.id);
        for (const connection of connections) {
          if (connection.id === undefined || !isAlchemyOwned(connection.labels)) continue;
          attrs.push(toAttrs(scope, connection.id, connection));
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The spec doesn't say an explicit name can be held twice on a gateway, and an
      // unresolved id can resolve to the gateway the connection sits on: delete the old
      // one first. A generated name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<ConnectionProps>(news, ["gatewayId", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<ConnectionProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ConnectionProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      if (scopeChanged || resolved.gatewayId !== output.gatewayId) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A new key counts: the engine compares a `Redacted` by its value.
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const projectScope = yield* resolveProjectScope(olds, output);
      const gatewayId = output?.gatewayId ?? olds?.gatewayId;
      if (gatewayId === undefined) return undefined;
      const scope = { ...projectScope, gatewayId };
      if (output?.connectionId !== undefined) {
        const byId = yield* getConnectionOrUndefined(scope, output.connectionId);
        if (byId !== undefined) return toAttrs(scope, output.connectionId, byId);
      }
      const connections = yield* listGatewayConnections(projectScope, gatewayId);
      // A crashed create has neither state nor a previous generation, and any generation of
      // this logical id is ours. A replacement only owns its own.
      const owned = yield* findOwnedGeneration(
        id,
        readGeneration({ instanceId, output, previous }),
        connections,
        (connection) => connection.labels,
      );
      if (owned?.id !== undefined) return toAttrs(scope, owned.id, owned);
      if (olds?.displayName === undefined) return undefined;
      // A display name found twice is evidently no identity, so it claims nothing.
      const named = connections.filter((connection) => connection.displayName === olds.displayName);
      const found = named.length === 1 ? named[0] : undefined;
      if (found?.id === undefined) return undefined;
      const attrs = toAttrs(scope, found.id, found);
      const isPrevious =
        previous?.connectionId === found.id &&
        previous.gatewayId === gatewayId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const projectScope = yield* resolveProjectScope(news, output);
      const scope = { ...projectScope, gatewayId: news.gatewayId };
      const displayName = news.displayName ?? output?.displayName ?? (yield* generatedName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const enabled = news.enabled ?? true;

      // 1. Observe — `output` is a cache for the id, and only names the desired connection
      // while it sits on the same gateway. Without it, only this generation's connection
      // can be claimed.
      let current: vpn.ConnectionResponseOutput | undefined =
        output?.connectionId !== undefined &&
        output.gatewayId === scope.gatewayId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* getConnectionOrUndefined(scope, output.connectionId)
          : undefined;
      current ??= yield* findGeneration(scope, id, instanceId);
      const observed = current;

      return yield* Effect.gen(function* () {
        const gateway = yield* settleGateway(projectScope, scope.gatewayId);
        const staleErrors = gateway?.state === "ERROR" ? STALE_ERROR_POLLS : 0;

        // 2. Ensure — the only time both keys always go out.
        if (observed === undefined) {
          const created = yield* vpn.createGatewayConnection({
            ...scope,
            displayName,
            enabled,
            localSubnets: news.localSubnets,
            remoteSubnets: news.remoteSubnets,
            staticRoutes: news.staticRoutes,
            tunnel1: news.tunnel1,
            tunnel2: news.tunnel2,
            labels,
          });
          const createdId = yield* requireId(`connection ${displayName}`, created.id);
          yield* waitForGatewayReady(projectScope, scope.gatewayId, { staleErrors });
          const live = yield* vpn.getGatewayConnection({ ...scope, connectionId: createdId });
          return toAttrs(scope, createdId, live);
        }
        const connectionId = yield* requireId(`connection ${displayName}`, observed.id);

        // 3. Sync — the API has one full-body update, so one diff decides it. Observed state
        // can't show a field the user removed, since `covers` ignores what the props leave
        // out, so the previous props flag that. Keys can't be observed at all: `olds` decides.
        const keysChanged =
          olds === undefined ||
          secretsDiffer(news.tunnel1.preSharedKey, olds.tunnel1.preSharedKey) ||
          secretsDiffer(news.tunnel2.preSharedKey, olds.tunnel2.preSharedKey);
        const declarationChanged =
          olds !== undefined &&
          JSON.stringify(declaration(olds)) !== JSON.stringify(declaration(news));
        const inSync =
          observed.displayName === displayName &&
          (observed.enabled ?? true) === enabled &&
          covers(news.localSubnets, observed.localSubnets) &&
          covers(news.remoteSubnets, observed.remoteSubnets) &&
          covers(news.staticRoutes, observed.staticRoutes) &&
          covers(withoutKey(news.tunnel1), observed.tunnel1) &&
          covers(withoutKey(news.tunnel2), observed.tunnel2) &&
          !labelsChanged(observed.labels, labels);

        // 4. Return, when there is nothing to change.
        if (!keysChanged && !declarationChanged && inSync) {
          yield* waitForGatewayReady(projectScope, scope.gatewayId);
          return toAttrs(scope, connectionId, observed);
        }

        /** A list the props set; else cleared if they used to set it, else kept as it is live. */
        const managedList = (
          desired: string[] | undefined,
          previous: string[] | undefined,
          live: ReadonlyArray<string> | undefined,
        ) => desired ?? (previous !== undefined ? undefined : live && [...live]);

        yield* vpn.updateGatewayConnection({
          ...scope,
          connectionId,
          displayName,
          enabled,
          localSubnets: managedList(news.localSubnets, olds?.localSubnets, observed.localSubnets),
          remoteSubnets: managedList(
            news.remoteSubnets,
            olds?.remoteSubnets,
            observed.remoteSubnets,
          ),
          // No `minItems` on this one, so an empty list can clear it.
          staticRoutes:
            news.staticRoutes ??
            (olds?.staticRoutes !== undefined
              ? []
              : observed.staticRoutes && [...observed.staticRoutes]),
          tunnel1: tunnelToUpdate(news.tunnel1, olds?.tunnel1),
          tunnel2: tunnelToUpdate(news.tunnel2, olds?.tunnel2),
          labels,
        });
        yield* waitForGatewayReady(projectScope, scope.gatewayId, { staleErrors });
        const live = yield* vpn.getGatewayConnection({ ...scope, connectionId });
        return toAttrs(scope, connectionId, live);
      }).pipe(withGatewayConnectionLock(projectScope, scope.gatewayId));
    }),

    delete: Effect.fn(function* ({ output }) {
      const projectScope = { projectId: output.projectId, region: output.region };
      const scope = { ...projectScope, gatewayId: output.gatewayId };
      const { connectionId } = output;
      yield* Effect.gen(function* () {
        yield* vpn
          .deleteGatewayConnection({ ...scope, connectionId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitUntilGone({
          resource: `STACKIT VPN connection ${output.displayName}`,
          read: getConnectionOrUndefined(scope, connectionId),
          timeout: CONNECTION_DELETE_TIMEOUT,
        });
        // What deletes next on this gateway shouldn't race the change landing on it.
        yield* settleGateway(projectScope, scope.gatewayId);
      }).pipe(withGatewayConnectionLock(projectScope, scope.gatewayId));
    }),
  });
