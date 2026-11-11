import * as DO from "@distilled.cloud/digitalocean";
import type {
  LoadBalancer as ApiLoadBalancer,
  LoadBalancerStatus,
} from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";
import type { RegionSlug } from "./Slugs.ts";

export type { LoadBalancerStatus } from "@distilled.cloud/digitalocean";

export type LoadBalancerEntryProtocol = "http" | "https" | "http2" | "http3" | "tcp" | "udp";
export type LoadBalancerTargetProtocol = "http" | "https" | "http2" | "tcp" | "udp";

export type LoadBalancerForwardingRule = {
  /** Protocol clients use to reach the load balancer. */
  entryProtocol: LoadBalancerEntryProtocol;
  /** Port clients connect to. */
  entryPort: number;
  /** Protocol the load balancer uses to reach the droplets. */
  targetProtocol: LoadBalancerTargetProtocol;
  /** Port on the droplets. */
  targetPort: number;
  /** Certificate for `https`, `http2` or `http3` entry; omit with `tlsPassthrough`. */
  certificateId?: string;
  /** Pass TLS through to the droplets instead of terminating it. */
  tlsPassthrough?: boolean;
};

export type LoadBalancerHealthCheck = {
  /** @default "http" */
  protocol?: "http" | "https" | "tcp";
  /** @default 80 */
  port?: number;
  /** Path for `http` and `https` checks. @default "/" */
  path?: string;
  /** @default 10 */
  checkIntervalSeconds?: number;
  /** @default 5 */
  responseTimeoutSeconds?: number;
  /** @default 5 */
  unhealthyThreshold?: number;
  /** @default 3 */
  healthyThreshold?: number;
};

export type LoadBalancerStickySessions = {
  /** `"cookies"` pins a client to one droplet. @default "none" */
  type: "none" | "cookies";
  /** Cookie name when `type` is `"cookies"`. */
  cookieName?: string;
  /** Cookie lifetime in seconds when `type` is `"cookies"`. */
  cookieTtlSeconds?: number;
};

export type LoadBalancerProps = {
  /**
   * Display name. A change renames the load balancer in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Region slug. A change replaces the load balancer. */
  region: RegionSlug;
  /**
   * Number of nodes, 1 to 100. Each node handles about 10,000 connections.
   * A change resizes the load balancer in place.
   *
   * @default 1
   */
  sizeUnit?: number;
  /** How traffic enters and where it goes. At least one rule. */
  forwardingRules: LoadBalancerForwardingRule[];
  /** How the load balancer decides a droplet is healthy. */
  healthCheck?: LoadBalancerHealthCheck;
  /** Pin clients to one droplet. */
  stickySessions?: LoadBalancerStickySessions;
  /** Droplets behind the load balancer. Set this or `tag`, not both. */
  dropletIds?: number[];
  /** Every droplet with this tag is behind the load balancer. Set this or `dropletIds`. */
  tag?: string;
  /**
   * Redirect HTTP on port 80 to HTTPS on port 443.
   *
   * @default false
   */
  redirectHttpToHttps?: boolean;
  /** Send the PROXY protocol header to the droplets. @default false */
  enableProxyProtocol?: boolean;
  /** Keep connections to the droplets open between requests. @default false */
  enableBackendKeepalive?: boolean;
  /** Seconds an idle HTTP connection stays open, 30 to 600. @default 60 */
  httpIdleTimeoutSeconds?: number;
  /** VPC for the load balancer and its droplets. A change replaces the load balancer. */
  vpcUuid?: string;
  /**
   * `"INTERNAL"` gives the load balancer only a private address in the VPC.
   * A change replaces the load balancer.
   *
   * @default "EXTERNAL"
   */
  network?: "EXTERNAL" | "INTERNAL";
  /** Allow or deny client sources, for example `["ip:203.0.113.0/24", "cidr:..."]`. */
  firewall?: { allow?: string[]; deny?: string[] };
  /** Do not create DNS records for Let's Encrypt certificates on the load balancer. */
  disableLetsEncryptDnsRecords?: boolean;
};

export type LoadBalancer = Resource<
  "DigitalOcean.LoadBalancer",
  LoadBalancerProps,
  {
    /** Load balancer id (UUID). */
    loadBalancerId: string;
    /** Uniform resource name, `do:loadbalancer:<id>`, for `ProjectResources`. */
    urn: string;
    /** Display name. */
    name: string;
    /** Public IPv4 address, or the private one for an internal load balancer. */
    ip: string | undefined;
    /** Public IPv6 address, when DigitalOcean assigned one. */
    ipv6: string | undefined;
    /** Status, `active` once it serves traffic. */
    status: LoadBalancerStatus;
    /** Region slug. */
    region: string;
    /** Number of nodes. */
    sizeUnit: number | undefined;
    /** Droplets behind the load balancer. */
    dropletIds: number[];
    /** Droplet tag the load balancer targets, if any. */
    tag: string | undefined;
    /** VPC id. */
    vpcUuid: string | undefined;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type LoadBalancerAttributes = LoadBalancer["Attributes"];

/**
 * A DigitalOcean regional Load Balancer in front of droplets. Forwarding
 * rules, health checks, sticky sessions, its targets and its size update
 * in place; `region`, `vpcUuid` and `network` replace it, with a new IP.
 *
 * A load balancer has no tags of its own. Alchemy owns one whose name it
 * generated or whose id it recorded; a load balancer that already has the
 * chosen name is `Unowned` and needs `--adopt`.
 *
 * ### Balancing HTTP
 * **Example:** Two droplets behind a load balancer
 * ```typescript
 * const web = (name: string) =>
 *   DigitalOcean.Droplet(name, {
 *     region: "sfo3",
 *     size: "s-1vcpu-1gb",
 *     image: "ubuntu-24-04-x64",
 *     userData: "#cloud-config\npackages: [nginx]",
 *   });
 * const a = yield* web("web-a");
 * const b = yield* web("web-b");
 * const lb = yield* DigitalOcean.LoadBalancer("web", {
 *   region: "sfo3",
 *   forwardingRules: [
 *     { entryProtocol: "http", entryPort: 80, targetProtocol: "http", targetPort: 80 },
 *   ],
 *   healthCheck: { protocol: "http", port: 80, path: "/" },
 *   dropletIds: [a.dropletId, b.dropletId],
 * });
 * // Serve traffic at lb.ip.
 * ```
 *
 * ### Targeting Droplets by Tag
 * **Example:** Every droplet tagged `web`
 * ```typescript
 * const tag = yield* DigitalOcean.Tag("web", { name: "web" });
 * const lb = yield* DigitalOcean.LoadBalancer("web", {
 *   region: "sfo3",
 *   forwardingRules: [
 *     { entryProtocol: "http", entryPort: 80, targetProtocol: "http", targetPort: 80 },
 *   ],
 *   tag: tag.name,
 * });
 * ```
 *
 * ### Terminating TLS
 * **Example:** HTTPS with a Let's Encrypt certificate
 * ```typescript
 * const cert = yield* DigitalOcean.Certificate("web-cert", {
 *   type: "lets_encrypt",
 *   dnsNames: ["shop.example.com"],
 * });
 * const lb = yield* DigitalOcean.LoadBalancer("web", {
 *   region: "sfo3",
 *   forwardingRules: [
 *     {
 *       entryProtocol: "https",
 *       entryPort: 443,
 *       targetProtocol: "http",
 *       targetPort: 80,
 *       certificateId: cert.certificateId,
 *     },
 *   ],
 *   redirectHttpToHttps: true,
 *   tag: "web",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Load-Balancers
 *
 * @resource
 * @product Load Balancers
 * @category Networking
 */
export const LoadBalancer = Resource<LoadBalancer>("DigitalOcean.LoadBalancer");

export class LoadBalancerWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.LoadBalancerWaitTimedOut",
)<{
  readonly loadBalancerId: string;
  readonly waitingFor: string;
  readonly lastStatus: LoadBalancerStatus | undefined;
}> {
  override get message() {
    return `Load balancer ${this.loadBalancerId} timed out waiting for ${this.waitingFor} (last status: ${this.lastStatus ?? "missing"}).`;
  }
}

export class LoadBalancerErrored extends Data.TaggedError("DigitalOcean.LoadBalancerErrored")<{
  readonly loadBalancerId: string;
}> {
  override get message() {
    return `Load balancer ${this.loadBalancerId} is in the 'errored' state.`;
  }
}

const NAME_MAX_LENGTH = 255;

const PAGE_SIZE = 200;

// A load balancer takes one to three minutes to become active (≈ 5 min budget).
const PROVISIONING_POLL: PollBudget = { maxDelay: "10 seconds", times: 36 };

// Deletion finishes within a minute.
const DELETE_POLL: PollBudget = { maxDelay: "5 seconds", times: 30 };

const toAttrs = (lb: ApiLoadBalancer): LoadBalancerAttributes => ({
  loadBalancerId: lb.id,
  urn: `do:loadbalancer:${lb.id}`,
  name: lb.name,
  ip: lb.ip || undefined,
  ipv6: lb.ipv6 || undefined,
  status: lb.status,
  region: lb.region?.slug ?? "",
  sizeUnit: lb.size_unit ?? undefined,
  dropletIds: [...(lb.droplet_ids ?? [])],
  tag: lb.tag || undefined,
  vpcUuid: lb.vpc_uuid || undefined,
  createdAt: lb.created_at,
});

const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: NAME_MAX_LENGTH });

const toApiBody = (name: string, news: LoadBalancerProps) => ({
  name,
  region: news.region,
  size_unit: news.sizeUnit ?? 1,
  forwarding_rules: news.forwardingRules.map((rule) => ({
    entry_protocol: rule.entryProtocol,
    entry_port: rule.entryPort,
    target_protocol: rule.targetProtocol,
    target_port: rule.targetPort,
    certificate_id: rule.certificateId,
    tls_passthrough: rule.tlsPassthrough,
  })),
  health_check:
    news.healthCheck === undefined
      ? undefined
      : {
          protocol: news.healthCheck.protocol,
          port: news.healthCheck.port,
          path: news.healthCheck.path,
          check_interval_seconds: news.healthCheck.checkIntervalSeconds,
          response_timeout_seconds: news.healthCheck.responseTimeoutSeconds,
          unhealthy_threshold: news.healthCheck.unhealthyThreshold,
          healthy_threshold: news.healthCheck.healthyThreshold,
        },
  sticky_sessions:
    news.stickySessions === undefined
      ? undefined
      : {
          type: news.stickySessions.type,
          cookie_name: news.stickySessions.cookieName,
          cookie_ttl_seconds: news.stickySessions.cookieTtlSeconds,
        },
  redirect_http_to_https: news.redirectHttpToHttps ?? false,
  enable_proxy_protocol: news.enableProxyProtocol ?? false,
  enable_backend_keepalive: news.enableBackendKeepalive ?? false,
  http_idle_timeout_seconds: news.httpIdleTimeoutSeconds,
  vpc_uuid: news.vpcUuid,
  network: news.network,
  firewall: news.firewall,
  disable_lets_encrypt_dns_records: news.disableLetsEncryptDnsRecords,
  ...(news.tag !== undefined ? { tag: news.tag } : { droplet_ids: news.dropletIds ?? [] }),
});

const observeById = (loadBalancerId: string) =>
  noneIfNotFound(
    DO.getLoadBalancer({ lb_id: loadBalancerId }).pipe(Effect.map((r) => r.load_balancer)),
  );

const observeByName = (name: string) =>
  DO.listLoadBalancers.items({ per_page: PAGE_SIZE }).pipe(
    Stream.filter((lb) => lb.name === name),
    Stream.runHead,
  );

const observeOwned = Effect.fn(function* (
  loadBalancerId: string | undefined,
  generatedName: string | undefined,
) {
  if (loadBalancerId !== undefined) {
    const byId = yield* observeById(loadBalancerId);
    if (Option.isSome(byId)) return byId;
  }
  if (generatedName === undefined) return Option.none<ApiLoadBalancer>();
  return yield* observeByName(generatedName);
});

const waitUntilActive = (loadBalancerId: string) =>
  pollUntil(observeById(loadBalancerId), {
    ...PROVISIONING_POLL,
    until: (observed): observed is Option.Some<ApiLoadBalancer> =>
      Option.isSome(observed) &&
      (observed.value.status === "active" || observed.value.status === "errored"),
    onTimeout: (last) =>
      new LoadBalancerWaitTimedOut({
        loadBalancerId,
        waitingFor: "the active state",
        lastStatus: Option.getOrUndefined(last)?.status,
      }),
  }).pipe(
    Effect.map((observed) => observed.value),
    Effect.filterOrFail(
      (lb) => lb.status === "active",
      () => new LoadBalancerErrored({ loadBalancerId }),
    ),
  );

const waitUntilGone = (loadBalancerId: string) =>
  pollUntil(observeById(loadBalancerId), {
    ...DELETE_POLL,
    until: Option.isNone,
    onTimeout: (last) =>
      new LoadBalancerWaitTimedOut({
        loadBalancerId,
        waitingFor: "deletion",
        lastStatus: Option.getOrUndefined(last)?.status,
      }),
  });

export const LoadBalancerProvider = () =>
  Provider.succeed(LoadBalancer, {
    stables: ["loadBalancerId", "urn", "region", "createdAt"],
    // A load balancer carries no ownership marker.
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const generatedName = olds.name === undefined ? yield* physicalName(id) : undefined;
      const owned = yield* observeOwned(output?.loadBalancerId, generatedName);
      if (Option.isSome(owned)) return toAttrs(owned.value);
      if (olds.name === undefined) return undefined;
      const named = yield* observeByName(olds.name);
      return named.pipe(
        Option.map((lb) =>
          lb.id === previous?.loadBalancerId ? toAttrs(lb) : Unowned(toAttrs(lb)),
        ),
        Option.getOrUndefined,
      );
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.region !== olds.region ||
        news.vpcUuid !== olds.vpcUuid ||
        (news.network ?? "EXTERNAL") !== (olds.network ?? "EXTERNAL")
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const generatedName = news.name === undefined ? name : undefined;
      const body = toApiBody(name, news);

      const observed = yield* observeOwned(output?.loadBalancerId, generatedName);
      const loadBalancerId = yield* Option.match(observed, {
        onNone: () => DO.createLoadBalancer({ body }).pipe(Effect.map((r) => r.load_balancer.id)),
        // The update is a full replacement of the configuration, so it is
        // sent every time; DigitalOcean applies only what changed.
        onSome: (lb) =>
          waitUntilActive(lb.id).pipe(
            Effect.andThen(DO.updateLoadBalancer({ lb_id: lb.id, body })),
            Effect.as(lb.id),
          ),
      });
      return toAttrs(yield* waitUntilActive(loadBalancerId));
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteLoadBalancer({ lb_id: output.loadBalancerId }));
      yield* waitUntilGone(output.loadBalancerId);
    }),
  });
