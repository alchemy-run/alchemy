import * as lb from "@distilled.cloud/stackit/load_balancer";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
  systemLabels,
  withoutSystemLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  covers,
  getLoadBalancerOrUndefined,
  listAllLoadBalancers,
  LOAD_BALANCER_SERVICE_ID,
  physicalName,
} from "./internal.ts";

/** A network the load balancer uses for its listeners and targets. */
export interface LoadBalancerNetwork {
  /** Id of the STACKIT network, e.g. `network.networkId`. */
  networkId: string;
  /**
   * How the load balancer uses the network. STACKIT's API text says only
   * `ROLE_LISTENERS_AND_TARGETS` is supported today.
   * @default "ROLE_LISTENERS_AND_TARGETS"
   */
  role?: "ROLE_LISTENERS_AND_TARGETS" | "ROLE_LISTENERS" | "ROLE_TARGETS";
}

/** Protocol options of a TCP, TCP proxy or TLS passthrough listener. */
export interface LoadBalancerTcpOptions {
  /**
   * Connection idle timeout, in seconds with an `s` unit, e.g. `"300s"`. The
   * API documents a default of 5 minutes and a maximum of one hour.
   */
  idleTimeout?: string;
}

/** Protocol options of a UDP listener. */
export interface LoadBalancerUdpOptions {
  /**
   * Session idle timeout, in seconds with an `s` unit, e.g. `"60s"`. The API
   * documents a default of 1 minute and a maximum of 2 minutes.
   */
  idleTimeout?: string;
}

/** A port the load balancer accepts traffic on. */
export interface LoadBalancerListener {
  /** Display name. STACKIT derives `<protocol>-<port>` as the listener's `name` without one. */
  displayName?: string;
  /** Port to listen on (1-65535). */
  port: number;
  /** Protocol to balance. */
  protocol: "PROTOCOL_TCP" | "PROTOCOL_UDP" | "PROTOCOL_TCP_PROXY" | "PROTOCOL_TLS_PASSTHROUGH";
  /** Name of the target pool that receives this listener's traffic. */
  targetPool: string;
  /** TCP options, for the TCP-based protocols. */
  tcp?: LoadBalancerTcpOptions;
  /** UDP options, for `PROTOCOL_UDP`. */
  udp?: LoadBalancerUdpOptions;
}

/** A backend that receives traffic. */
export interface LoadBalancerTarget {
  /** Display name of the target. */
  displayName?: string;
  /** IP address of the target, unique within its pool. */
  ip: string;
}

/** TLS settings of an HTTP health check. */
export interface LoadBalancerHealthCheckTls {
  /** Probe over TLS. */
  enabled?: boolean;
  /** Custom CA to trust, in addition to the public ones. */
  customCa?: string;
  /** Skip certificate validation. Insecure; for testing only. */
  skipCertificateValidation?: boolean;
}

/** HTTP settings of an active health check. */
export interface LoadBalancerHttpHealthCheck {
  /** Path the probe requests. */
  path?: string;
  /** HTTP status codes that count as healthy. */
  okStatuses?: string[];
  /** TLS settings of the probe. */
  tls?: LoadBalancerHealthCheckTls;
}

/** How a target pool's targets are probed. */
export interface LoadBalancerActiveHealthCheck {
  /** Port to probe instead of the pool's `targetPort`. */
  altPort?: number;
  /** Successful probes before a target counts as healthy (1-1000000). */
  healthyThreshold?: number;
  /** Failed probes before a target counts as unhealthy (1-1000000). */
  unhealthyThreshold?: number;
  /** Time between probes, in seconds with an `s` unit, e.g. `"3s"`. */
  interval?: string;
  /** Random jitter added to `interval`, e.g. `"1s"`. */
  intervalJitter?: string;
  /** Probe timeout, e.g. `"3s"`. */
  timeout?: string;
  /** Probe over HTTP instead of a plain connection. */
  httpHealthChecks?: LoadBalancerHttpHealthCheck;
}

/** Session persistence of a target pool. */
export interface LoadBalancerSessionPersistence {
  /**
   * Send every connection from one source IP address to the same target. This
   * changes the pool's algorithm from round robin to Maglev.
   */
  useSourceIpAddress?: boolean;
}

/** A named group of targets. */
export interface LoadBalancerTargetPool {
  /** Pool name, referenced by a listener's `targetPool`. */
  name: string;
  /** Port the targets listen on (1-65535). */
  targetPort: number;
  /** Targets of the pool, at most 250. */
  targets: LoadBalancerTarget[];
  /** Health check of the pool's targets. */
  activeHealthCheck?: LoadBalancerActiveHealthCheck;
  /** Session persistence of the pool. */
  sessionPersistence?: LoadBalancerSessionPersistence;
}

/** Where a load balancer ships its logs or metrics. */
export interface LoadBalancerObservabilityTarget {
  /** Basic-auth credential for the endpoint, e.g. `credential.credentialsRef`. */
  credentialsRef?: string;
  /** Remote-write push URL of the endpoint. */
  pushUrl?: string;
}

/** Optional behaviour of a load balancer. */
export interface LoadBalancerOptions {
  /**
   * IP ranges allowed to use the load balancer, in CIDR notation. Updated in
   * place.
   */
  accessControl?: {
    /** Allowed source ranges. */
    allowedSourceRanges?: string[];
  };
  /**
   * Per-request access logs. They need a STACKIT Telemetry Router to be
   * viewable. Updated in place.
   * @default false
   */
  accessLogs?: boolean;
  /**
   * Have STACKIT create a public IP for this load balancer. Use it instead of
   * `externalAddress`. Changing it replaces the load balancer.
   * @default false
   */
  ephemeralAddress?: boolean;
  /** Where to ship logs and metrics. Updated in place. */
  observability?: {
    /** Logs destination (STACKIT Observability or Loki remote write). */
    logs?: LoadBalancerObservabilityTarget;
    /** Metrics destination (STACKIT Observability or Prometheus remote write). */
    metrics?: LoadBalancerObservabilityTarget;
  };
  /**
   * Reachable only through a private IP in the network. Changing it replaces
   * the load balancer.
   * @default false
   */
  privateNetworkOnly?: boolean;
}

export interface LoadBalancerProps extends ProjectScopedProps {
  /**
   * Name of the load balancer, the API's key for it: 1-63 characters of
   * `[0-9a-z-]`. Changing it replaces the load balancer.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * Service plan, which sizes the load balancer: `p10`, `p50`, `p250` or
   * `p750` today. List a region's plans with `ListPlans`. Updated in place.
   * @default the API's default plan
   */
  planId?: string;
  /**
   * The network the listeners and targets live in. STACKIT allows exactly one
   * today. Changing it replaces the load balancer.
   */
  networks: LoadBalancerNetwork[];
  /** Ports to listen on, at most 20. Updated in place. */
  listeners: LoadBalancerListener[];
  /**
   * Target pools, at most 20. Updated in place, and declared here as the full
   * set, so targets added at runtime with `UpdateTargetPool` are removed by the
   * next update of this resource.
   */
  targetPools: LoadBalancerTargetPool[];
  /**
   * Existing public IP to expose the load balancer on, e.g. `ip.ip` of a
   * `Stackit.IaaS.PublicIp`. STACKIT does not check it when the load balancer
   * is created: it surfaces in `errors` instead. Changing it replaces the load
   * balancer, deleting the old one first so the new one can take the address.
   */
  externalAddress?: string;
  /** Optional behaviour. Each option's prop says whether it updates in place. */
  options?: LoadBalancerOptions;
  /**
   * Keep STACKIT from assigning its security group to the targets, so targets
   * outside the network can be used. You then manage routing and security
   * groups yourself. Changing it replaces the load balancer.
   * @default false
   */
  disableTargetSecurityGroupAssignment?: boolean;
  /**
   * User labels, at most 64 including Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`), which are added automatically. Keys starting
   * with `stackit-` are reserved by STACKIT. Updated in place.
   */
  labels?: Record<string, string>;
}

export interface LoadBalancerAttributes {
  /** Name of the load balancer. */
  loadBalancerName: string;
  /** Project of the load balancer. */
  projectId: string;
  /** Region of the load balancer. */
  region: string;
  /** Service plan. */
  planId: string | undefined;
  /** Public IP the load balancer is exposed on, if any. */
  externalAddress: string | undefined;
  /** Private IP of the load balancer. STACKIT documents that it can change at any time. */
  privateAddress: string | undefined;
  /** Status; `STATUS_READY` after a successful deploy. */
  status: string | undefined;
  /** Resource version, which changes with every update. */
  version: string | undefined;
  /** The network the load balancer uses. */
  networks: lb.Network[];
  /** Listeners, with their server-computed `name`. */
  listeners: lb.Listener[];
  /** Target pools as STACKIT reports them. */
  targetPools: lb.TargetPool[];
  /** Security group permitting traffic from the load balancer to its targets. */
  loadBalancerSecurityGroup: lb.SecurityGroup | undefined;
  /** Security group allowing targets to receive the load balancer's traffic. */
  targetSecurityGroup: lb.SecurityGroup | undefined;
  /** Problems STACKIT reports on the load balancer, e.g. an inactive target. */
  errors: lb.LoadBalancerError[];
  /** Whether STACKIT leaves the targets' security groups alone. */
  disableTargetSecurityGroupAssignment: boolean;
  /** Whether the load balancer is reachable through a private IP only. */
  privateNetworkOnly: boolean;
  /** Whether STACKIT created the public IP for this load balancer. */
  ephemeralAddress: boolean;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type LoadBalancer = Resource<
  "Stackit.LoadBalancer.LoadBalancer",
  LoadBalancerProps,
  LoadBalancerAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Network Load Balancer: a layer 4 load balancer (TCP, UDP, TCP proxy,
 * TLS passthrough) in front of IP targets. STACKIT deploys two VMs in your
 * project for each one, subject to a fee, and bills per hour by service plan.
 *
 * Listeners, target pools, plan, access control, observability and labels update
 * in place. The name, network, public address and security-group assignment
 * can't change, so changing them replaces the load balancer. Deploys wait for
 * `STATUS_READY`, for up to 45 minutes, and fail with the errors STACKIT reports
 * when it enters `STATUS_ERROR`; a later deploy re-submits the configuration.
 * Destroys wait until it is gone, for up to 15 minutes. The first deploy also
 * enables the service (`cloud.stackit.loadbalancer`) for the project.
 *
 * Ownership is tracked with labels. A load balancer with the same name that
 * lacks them is reported as unowned and only taken over with `--adopt`.
 *
 * ### Creating a Load Balancer
 * **Example:** A public TCP load balancer on an existing public IP
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const address = yield* Stackit.IaaS.PublicIp("Address", {});
 * const web = yield* Stackit.IaaS.NetworkInterface("WebNic", {
 *   networkId: network.networkId,
 * });
 *
 * const balancer = yield* Stackit.LoadBalancer.LoadBalancer("Web", {
 *   planId: "p10",
 *   networks: [{ networkId: network.networkId }],
 *   externalAddress: address.ip,
 *   listeners: [
 *     { displayName: "http", port: 80, protocol: "PROTOCOL_TCP", targetPool: "web" },
 *   ],
 *   targetPools: [
 *     {
 *       name: "web",
 *       targetPort: 8080,
 *       targets: [{ displayName: "web-1", ip: web.ipv4.as<string>() }],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Let STACKIT create the public IP
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const balancer = yield* Stackit.LoadBalancer.LoadBalancer("Web", {
 *   networks: [{ networkId: network.networkId }],
 *   options: { ephemeralAddress: true },
 *   listeners: [{ port: 80, protocol: "PROTOCOL_TCP", targetPool: "web" }],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 * // balancer.externalAddress is the address STACKIT assigned.
 * ```
 *
 * **Example:** A load balancer reachable only inside the network
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const balancer = yield* Stackit.LoadBalancer.LoadBalancer("Internal", {
 *   networks: [{ networkId: network.networkId }],
 *   options: { privateNetworkOnly: true },
 *   listeners: [{ port: 5432, protocol: "PROTOCOL_TCP", targetPool: "db" }],
 *   targetPools: [
 *     { name: "db", targetPort: 5432, targets: [{ ip: "10.0.1.20" }] },
 *   ],
 * });
 * // balancer.privateAddress is the address to connect to; it can change.
 * ```
 *
 * ### Configuring Target Pools
 * **Example:** HTTP health checks and session persistence
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const balancer = yield* Stackit.LoadBalancer.LoadBalancer("Web", {
 *   networks: [{ networkId: network.networkId }],
 *   options: { ephemeralAddress: true },
 *   listeners: [{ port: 80, protocol: "PROTOCOL_TCP", targetPool: "web" }],
 *   targetPools: [
 *     {
 *       name: "web",
 *       targetPort: 8080,
 *       targets: [
 *         { displayName: "web-1", ip: "10.0.1.10" },
 *         { displayName: "web-2", ip: "10.0.1.11" },
 *       ],
 *       activeHealthCheck: {
 *         interval: "10s",
 *         timeout: "3s",
 *         healthyThreshold: 2,
 *         unhealthyThreshold: 3,
 *         httpHealthChecks: { path: "/healthz", okStatuses: ["200"] },
 *       },
 *       sessionPersistence: { useSourceIpAddress: true },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Allow only an office range
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const balancer = yield* Stackit.LoadBalancer.LoadBalancer("Web", {
 *   networks: [{ networkId: network.networkId }],
 *   options: {
 *     ephemeralAddress: true,
 *     accessControl: { allowedSourceRanges: ["203.0.113.0/24"] },
 *   },
 *   listeners: [{ port: 443, protocol: "PROTOCOL_TLS_PASSTHROUGH", targetPool: "web" }],
 *   targetPools: [
 *     { name: "web", targetPort: 8443, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 * ```
 *
 * ### Shipping Logs and Metrics
 * **Example:** Remote write with a stored credential
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const password = yield* Config.redacted("METRICS_PASSWORD");
 * const credential = yield* Stackit.LoadBalancer.ObservabilityCredential("Metrics", {
 *   username: "metrics-writer",
 *   password,
 * });
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const balancer = yield* Stackit.LoadBalancer.LoadBalancer("Web", {
 *   networks: [{ networkId: network.networkId }],
 *   options: {
 *     ephemeralAddress: true,
 *     observability: {
 *       metrics: {
 *         credentialsRef: credential.credentialsRef,
 *         pushUrl: "https://metrics.example.com/api/v1/receive",
 *       },
 *     },
 *   },
 *   listeners: [{ port: 80, protocol: "PROTOCOL_TCP", targetPool: "web" }],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Register a target from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Balancer = Stackit.LoadBalancer.LoadBalancer("Web", {
 *   networks: [{ networkId: "11111111-1111-4111-8111-111111111111" }],
 *   options: { ephemeralAddress: true },
 *   listeners: [{ port: 80, protocol: "PROTOCOL_TCP", targetPool: "web" }],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const updateTargetPool = yield* Stackit.LoadBalancer.UpdateTargetPool(yield* Balancer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* updateTargetPool({
 *           targetPoolName: "web",
 *           targetPort: 8080,
 *           targets: [{ ip: "10.0.1.10" }, { ip: "10.0.1.11" }],
 *         });
 *         return HttpServerResponse.text("registered");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LoadBalancer.UpdateTargetPoolHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the network or an explicit name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new network replaces the load balancer. With an explicit `name`, or an
 * // `externalAddress` that stays the same, the old one is deleted first, so
 * // traffic stops until the new one is ready. With a generated name and no
 * // address to keep, the new one comes up first, with a new address.
 * const network = yield* Stackit.IaaS.Network("NetworkB", {
 *   ipv4: { prefix: "10.0.2.0/24" },
 * });
 * const balancer = yield* Stackit.LoadBalancer.LoadBalancer("Web", {
 *   name: "web",
 *   networks: [{ networkId: network.networkId }],
 *   options: { ephemeralAddress: true },
 *   listeners: [{ port: 80, protocol: "PROTOCOL_TCP", targetPool: "web" }],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.2.10" }] },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Network Load Balancer
 * @category LoadBalancer
 */
export const LoadBalancer = Resource<LoadBalancer>("Stackit.LoadBalancer.LoadBalancer");

/** Budget of the official SDK's create handler. */
const READY_TIMEOUT = "45 minutes";
/** Budget of the official SDK's delete handler. */
const DELETE_TIMEOUT = "15 minutes";
/** Provisioning takes minutes, so polls start slower than the shared default. */
const POLL = { interval: "5 seconds", maxInterval: "30 seconds" } as const;

const DEFAULT_ROLE = "ROLE_LISTENERS_AND_TARGETS";

/** How often a re-submitted load balancer may still report its old `STATUS_ERROR` (about 90s). */
const STALE_ERROR_POLLS = 6;

const errorSummary = (loadBalancer: lb.LoadBalancer2) => {
  const errors = (loadBalancer.errors ?? []).map(
    (error) => `${error.type ?? "TYPE_UNSPECIFIED"}: ${error.description ?? ""}`,
  );
  return errors.length > 0 ? errors.join("; ") : (loadBalancer.status ?? "STATUS_ERROR");
};

const toAttrs = (
  scope: ProjectScope,
  name: string,
  loadBalancer: lb.LoadBalancer2,
): LoadBalancerAttributes => ({
  loadBalancerName: loadBalancer.name ?? name,
  ...scope,
  planId: loadBalancer.planId,
  externalAddress: loadBalancer.externalAddress === "" ? undefined : loadBalancer.externalAddress,
  privateAddress: loadBalancer.privateAddress === "" ? undefined : loadBalancer.privateAddress,
  status: loadBalancer.status,
  version: loadBalancer.version,
  networks: [...(loadBalancer.networks ?? [])],
  listeners: [...(loadBalancer.listeners ?? [])],
  targetPools: [...(loadBalancer.targetPools ?? [])],
  loadBalancerSecurityGroup: loadBalancer.loadBalancerSecurityGroup,
  targetSecurityGroup: loadBalancer.targetSecurityGroup,
  errors: [...(loadBalancer.errors ?? [])],
  disableTargetSecurityGroupAssignment: loadBalancer.disableTargetSecurityGroupAssignment ?? false,
  privateNetworkOnly: loadBalancer.options?.privateNetworkOnly ?? false,
  ephemeralAddress: loadBalancer.options?.ephemeralAddress ?? false,
  labels: stripInternalLabels(withoutSystemLabels(loadBalancer.labels)),
});

const networkKeys = (networks: ReadonlyArray<{ networkId?: string; role?: string }>) =>
  networks.map((network) => `${network.networkId ?? ""}:${network.role ?? DEFAULT_ROLE}`);

const withDefaultRole = (networks: ReadonlyArray<LoadBalancerNetwork>): lb.Network[] =>
  networks.map((network) => ({ ...network, role: network.role ?? DEFAULT_ROLE }));

const waitForGone = (scope: ProjectScope, name: string, startedTerminating: boolean) => {
  // A load balancer already in `STATUS_ERROR` can report it once more before the
  // delete takes hold. Only an error after terminating is a failed delete.
  let sawTerminating = startedTerminating;
  return waitUntilGone({
    resource: `STACKIT load balancer ${name}`,
    read: getLoadBalancerOrUndefined(scope, name),
    failed: (loadBalancer: lb.LoadBalancer2) => {
      if (loadBalancer.status === "STATUS_TERMINATING") sawTerminating = true;
      return sawTerminating && loadBalancer.status === "STATUS_ERROR"
        ? errorSummary(loadBalancer)
        : undefined;
    },
    state: (loadBalancer: lb.LoadBalancer2) => loadBalancer.status,
    timeout: DELETE_TIMEOUT,
    ...POLL,
  });
};

export const LoadBalancerProvider = () =>
  Provider.succeed(LoadBalancer, {
    stables: ["loadBalancerName", "projectId", "region", "externalAddress"],
    // Delete order: the load balancer goes before what it uses.
    nuke: {
      dependsOn: [
        "Stackit.IaaS.Network",
        "Stackit.IaaS.PublicIp",
        "Stackit.LoadBalancer.ObservabilityCredential",
      ],
    },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const loadBalancers = yield* listAllLoadBalancers(scope);
      return loadBalancers
        .filter((loadBalancer) => isAlchemyOwned(loadBalancer.labels))
        .map((loadBalancer) => toAttrs(scope, loadBalancer.name ?? "", loadBalancer));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name or a kept address could resolve to what the old one
      // holds, and neither can be held twice: delete the old one first. A
      // generated name carries the generation, so it never collides.
      if (
        hasUnresolvedTrigger<LoadBalancerProps>(news, [
          "name",
          "projectId",
          "region",
          "networks",
          "externalAddress",
          "disableTargetSecurityGroupAssignment",
        ]) ||
        hasUnresolvedTrigger<LoadBalancerOptions>(rawProp<LoadBalancerProps>(news, "options"), [
          "ephemeralAddress",
          "privateNetworkOnly",
        ])
      ) {
        return {
          action: "replace",
          deleteFirst:
            rawProp<LoadBalancerProps>(news, "name") !== undefined ||
            rawProp<LoadBalancerProps>(news, "externalAddress") !== undefined,
        } as const;
      }
      const resolved = triggerProps<LoadBalancerProps>(news);

      const name = resolved.name ?? output.loadBalancerName;
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const addressChanged =
        resolved.externalAddress !== undefined
          ? resolved.externalAddress !== output.externalAddress
          : olds?.externalAddress !== undefined;
      if (
        scopeChanged ||
        addressChanged ||
        name !== output.loadBalancerName ||
        !sameMembers(networkKeys(resolved.networks), networkKeys(output.networks)) ||
        (resolved.disableTargetSecurityGroupAssignment ?? false) !==
          output.disableTargetSecurityGroupAssignment ||
        // The previous props first: the API may not echo every option.
        (resolved.options?.ephemeralAddress ?? false) !==
          (olds?.options?.ephemeralAddress ?? output.ephemeralAddress) ||
        (resolved.options?.privateNetworkOnly ?? false) !==
          (olds?.options?.privateNetworkOnly ?? output.privateNetworkOnly)
      ) {
        return {
          action: "replace",
          deleteFirst:
            (resolved.name !== undefined && !scopeChanged && name === output.loadBalancerName) ||
            (resolved.externalAddress !== undefined && !addressChanged),
        } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const recorded = output?.loadBalancerName ?? olds?.name;
      let observed: lb.LoadBalancer2 | undefined;
      if (recorded !== undefined) {
        observed = yield* getLoadBalancerOrUndefined(scope, recorded);
      } else if (previous !== undefined) {
        // A replacement looks for its own generated name only: labels can't
        // tell generations apart, and garbage collection deletes the old one.
        const generated = yield* physicalName(id);
        observed = yield* getLoadBalancerOrUndefined(scope, generated);
      } else {
        // A crashed create or lost state: find it by its labels.
        const all = yield* listAllLoadBalancers(scope);
        for (const candidate of all) {
          if (yield* hasAlchemyLabels(id, candidate.labels)) {
            observed = candidate;
            break;
          }
        }
      }
      // Going away: reconcile waits it out and creates a new one.
      if (observed === undefined || observed.status === "STATUS_TERMINATING") return undefined;
      const attrs = toAttrs(scope, recorded ?? observed.name ?? "", observed);
      // The generation being replaced is ours, but only at its own scope: a name is
      // unique per project and region, so elsewhere it can be someone else's.
      if (
        previous?.loadBalancerName === attrs.loadBalancerName &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region
      ) {
        return attrs;
      }
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = news.name ?? output?.loadBalancerName ?? (yield* physicalName(id));
      const labels = yield* desiredLabels(id, news.labels);
      const resource = `STACKIT load balancer ${name}`;
      const read = lb.getLoadBalancer({ ...scope, name });

      yield* ensureServiceEnabled({ ...scope, serviceId: LOAD_BALANCER_SERVICE_ID });

      // 1. Observe. The name is the API's key.
      let current = yield* getLoadBalancerOrUndefined(scope, name);
      if (current?.status === "STATUS_TERMINATING") {
        yield* waitForGone(scope, name, true);
        current = undefined;
      }

      // 2. Ensure. A conflict means someone just created this name: observe it.
      if (current === undefined) {
        current = yield* lb
          .createLoadBalancer({
            ...scope,
            name,
            planId: news.planId,
            networks: withDefaultRole(news.networks),
            listeners: news.listeners,
            targetPools: news.targetPools,
            externalAddress: news.externalAddress,
            options: news.options,
            disableTargetSecurityGroupAssignment: news.disableTargetSecurityGroupAssignment,
            labels,
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              getLoadBalancerOrUndefined(scope, name).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
      }

      // Wait out an in-flight create or update before comparing against it. A
      // load balancer in `STATUS_ERROR` isn't failed here: the sync below
      // re-submits the configuration, which may repair it.
      const settled =
        current.status === "STATUS_READY" || current.status === "STATUS_ERROR"
          ? current
          : yield* waitFor({
              resource,
              read,
              ready: (observed) =>
                observed.status === "STATUS_READY" || observed.status === "STATUS_ERROR",
              failed: (observed) =>
                observed.status === "STATUS_TERMINATING" ? "it is being deleted" : undefined,
              state: (observed) => observed.status,
              timeout: READY_TIMEOUT,
              ...POLL,
            });

      // 3. Sync. The API has one full-body update, so one diff decides it.
      const options = {
        accessControl: news.options?.accessControl,
        accessLogs: news.options?.accessLogs,
        observability: news.options?.observability,
      };
      const inSync = (observed: lb.LoadBalancer2) =>
        (news.planId === undefined || observed.planId === news.planId) &&
        covers(news.listeners, observed.listeners) &&
        covers(news.targetPools, observed.targetPools) &&
        covers(options, observed.options) &&
        !labelsChanged(withoutSystemLabels(observed.labels), labels);

      // Observed state can't show a field the user removed, since comparison
      // ignores what `news` leaves out, so the previous props flag it.
      const declarationChanged =
        olds !== undefined &&
        (JSON.stringify(olds.listeners) !== JSON.stringify(news.listeners) ||
          JSON.stringify(olds.targetPools) !== JSON.stringify(news.targetPools) ||
          JSON.stringify(olds.options) !== JSON.stringify(news.options));

      /** An option the props set; else cleared if they used to set it, else kept as it is live. */
      const managedOption = <K extends "accessControl" | "accessLogs" | "observability">(
        live: lb.LoadBalancer2,
        key: K,
      ) =>
        news.options?.[key] ??
        (olds?.options?.[key] !== undefined ? undefined : live.options?.[key]);

      // 4. Return, when there is nothing to change.
      if (settled.status !== "STATUS_ERROR" && !declarationChanged && inSync(settled)) {
        return toAttrs(scope, name, settled);
      }

      // Each attempt reads the version it updates. A conflict is a stale
      // version: read it again, at most 5 times.
      yield* read.pipe(
        Effect.flatMap((live) =>
          lb.updateLoadBalancer({
            ...scope,
            name,
            bodyName: name,
            version: live.version,
            planId: news.planId ?? live.planId,
            listeners: news.listeners,
            targetPools: news.targetPools,
            labels: { ...systemLabels(live.labels), ...labels },
            options: {
              privateNetworkOnly: live.options?.privateNetworkOnly,
              ephemeralAddress: live.options?.ephemeralAddress,
              accessControl: managedOption(live, "accessControl"),
              accessLogs: managedOption(live, "accessLogs"),
              observability: managedOption(live, "observability"),
            },
            // Not changeable, but the update takes the full resource.
            networks: live.networks,
            externalAddress: live.externalAddress,
            disableTargetSecurityGroupAssignment: live.disableTargetSecurityGroupAssignment,
          }),
        ),
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          schedule: Schedule.spaced("5 seconds"),
          times: 5,
        }),
      );

      let staleErrors = settled.status === "STATUS_ERROR" ? STALE_ERROR_POLLS : 0;
      const ready = yield* waitFor({
        resource,
        read,
        ready: (observed) => observed.status === "STATUS_READY",
        failed: (observed) => {
          if (observed.status === "STATUS_TERMINATING") return "it is being deleted";
          if (observed.status !== "STATUS_ERROR") {
            staleErrors = 0;
            return undefined;
          }
          if (staleErrors > 0) {
            staleErrors--;
            return undefined;
          }
          return errorSummary(observed);
        },
        state: (observed) => observed.status,
        timeout: READY_TIMEOUT,
        ...POLL,
      });

      return toAttrs(scope, name, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const name = output.loadBalancerName;
      const current = yield* getLoadBalancerOrUndefined(scope, name);
      if (current === undefined) return;
      if (current.status !== "STATUS_TERMINATING") {
        yield* lb
          .deleteLoadBalancer({ ...scope, name })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitForGone(scope, name, current.status === "STATUS_TERMINATING");
    }),
  });
