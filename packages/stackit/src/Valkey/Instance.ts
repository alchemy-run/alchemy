import type * as valkey from "@distilled.cloud/stackit/valkey";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import {
  commonParameters,
  definedParameters,
  makeInstanceLifecycle,
} from "../internal/dataServices.ts";
import type { Providers } from "../Providers.ts";
import { INSTANCE_LABEL, instanceApi, type ValkeyError } from "./internal.ts";

/** What the instance evicts when it reaches its memory limit. */
export type MaxmemoryPolicy =
  | "volatile-lru"
  | "allkeys-lru"
  | "volatile-random"
  | "allkeys-random"
  | "volatile-ttl"
  | "noeviction";

/** Valkey's `yes` / `no` setting. */
export type YesNo = "yes" | "no";

export interface InstanceProps {
  /**
   * Name of the instance. Changing it replaces the instance; removing it keeps the
   * current name.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Offering version. With `planName` it selects the plan from the offerings the API
   * lists for the project. Updates in place.
   */
  version: string;
  /**
   * Plan name, e.g. `stackit-keyvalue-1.2.10-replica`. A deploy fails with
   * `DataServicePlanNotFound`, listing the choices, when no such plan exists. Updates
   * in place.
   */
  planName: string;
  /**
   * IPv4 CIDR ranges allowed to connect, e.g. `203.0.113.7/32`. Anything else can't
   * open a connection, including any host using this service's bindings. Updates in
   * place. Leave it unset to keep STACKIT's default ranges.
   */
  acl?: string[];
  /**
   * Key that encrypts backups. The API can't read it back, so it is sent when it
   * differs from the last deploy's. Removing it leaves the key in place.
   */
  backupEncryptionKey?: string | Redacted.Redacted<string>;
  /** Whether updates install automatically. Leave it unset to keep the live setting. */
  automaticUpdates?: boolean;
  /** Turn on monitoring. Leave it unset to keep the API's default. */
  enableMonitoring?: boolean;
  /** Observability instance receiving the monitoring data. */
  monitoringInstanceId?: string;
  /** Graphite endpoint for metrics, as `host:port`. */
  graphite?: string;
  /** Seconds between emitted metrics. */
  metricsFrequency?: number;
  /** Prefix of emitted metrics. Some Graphite providers expect an API key here. */
  metricsPrefix?: string | Redacted.Redacted<string>;
  /** Percent of disk usage at which STACKIT's disk guard stops the service's processes. */
  maxDiskThreshold?: number;
  /** Syslog drains, as `host:port`. */
  syslog?: string[];
  /**
   * What to evict at the memory limit.
   *
   * @default "volatile-lru"
   */
  maxmemoryPolicy?: MaxmemoryPolicy;
  /**
   * Keys sampled per eviction.
   *
   * @default 5
   */
  maxmemorySamples?: number;
  /**
   * Most clients connected at once.
   *
   * @default 10000
   */
  maxclients?: number;
  /**
   * Keyspace events to publish, in Valkey's flag notation. Only the characters
   * `K`, `E`, `g`, `$`, `l`, `s`, `h`, `z`, `x`, `e`, `A` and `t` are allowed.
   */
  notifyKeyspaceEvents?: string;
  /** RDB save schedule, in Valkey's configuration syntax. */
  snapshot?: string;
  /**
   * Milliseconds without an answer before Sentinel considers a node down.
   *
   * @default 10000
   */
  downAfterMilliseconds?: number;
  /**
   * Sentinel's failover timeout, in milliseconds.
   *
   * @default 30000
   */
  failoverTimeout?: number;
  /**
   * Whether eviction frees memory in the background.
   *
   * @default "no"
   */
  lazyfreeLazyEviction?: YesNo;
  /**
   * Whether expiry frees memory in the background.
   *
   * @default "no"
   */
  lazyfreeLazyExpire?: YesNo;
  /**
   * Time limit of a Lua script, in milliseconds.
   *
   * @default 5000
   */
  luaTimeLimit?: number;
  /**
   * Replicas that must be connected for the primary to accept writes; 0 disables the
   * check. It shouldn't exceed the plan's number of nodes.
   *
   * @default 1
   */
  minReplicasToWrite?: number;
  /**
   * Seconds a replica may lag and still count towards `minReplicasToWrite`.
   *
   * @default 10
   */
  minReplicasMaxLag?: number;
  /**
   * Size of the replication backlog.
   *
   * @default "1mb"
   */
  replBacklogSize?: string;
  /** Project that owns the instance. Changing it replaces the instance. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the instance. @default the profile's region */
  region?: string;
}

export interface InstanceAttributes {
  /** STACKIT instance id. Stable across updates. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the instance. */
  name: string;
  /** Offering version. */
  version: string;
  /** Id of the plan. */
  planId: string;
  /** Name of the plan. */
  planName: string;
  /** IPv4 CIDR ranges allowed to connect, as the instance reports them. */
  acl: string[];
  /** Instance parameters as the API reports them, without `metrics_prefix`. */
  parameters: Record<string, unknown>;
  /** Name of the offering. */
  offeringName: string;
  /** Image of the offering. */
  imageUrl: string;
  /** URL of the instance's dashboard. */
  dashboardUrl: string;
  /** Cloud Foundry GUID of the instance. */
  cfGuid: string;
  /** Cloud Foundry GUID of its space. */
  cfSpaceGuid: string;
  /** Cloud Foundry GUID of its organization. */
  cfOrganizationGuid: string;
  /** State of the instance and its last operation; `active` after a deploy. */
  status: string | undefined;
  /** State of the service instance itself. */
  instanceStatus: string | undefined;
  /** The last operation, whose description holds the reason for a failure. */
  lastOperation: { type: string; state: string; description: string };
  /** Whether updates install automatically, when the props set it. */
  automaticUpdates: boolean | undefined;
}

export type Instance = Resource<
  "Stackit.Valkey.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A managed Valkey instance on STACKIT Key Value Store. Connection details come from a
 * `Stackit.Valkey.Credential`.
 *
 * Version, plan, ACL and the other parameters update in place. Name, project and
 * region replace the instance, and a replacement starts empty. Removing a parameter
 * prop leaves its live value as it is, since the API keeps what an update leaves out.
 * Deploys wait until the instance reports `active`, which takes minutes.
 *
 * This API has no labels. Alchemy knows an instance as its own by the id in state and
 * by the generated name, which holds the generation's id. An instance with an explicit
 * name and no state is reported as unowned, including one a deploy created before it
 * crashed: redeploy with `--adopt`, or delete it by hand. `alchemy unsafe nuke` only
 * finds generated names.
 *
 * Instances are billed per started hour by plan.
 *
 * ### Creating an Instance
 * **Example:** A replicated instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cache = yield* Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * ### Tuning Valkey
 * **Example:** Evict any key, and publish expiry events
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cache = yield* Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.0/24"],
 *   maxmemoryPolicy: "allkeys-lru",
 *   notifyKeyspaceEvents: "Ex",
 *   lazyfreeLazyExpire: "yes",
 *   downAfterMilliseconds: 30000,
 * });
 * ```
 *
 * ### Operating an Instance
 * **Example:** Monitoring, automatic updates and an encryption key for backups
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const cache = yield* Stackit.Valkey.Instance("Cache", {
 *   name: "sessions-production",
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.0/24"],
 *   automaticUpdates: true,
 *   backupEncryptionKey: Redacted.make("a-key-you-manage"),
 *   enableMonitoring: true,
 *   syslog: ["logs.example.com:54321"],
 * });
 * ```
 *
 * ### Running Commands
 * **Example:** Read and write keys from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cache = Stackit.Valkey.Instance("Cache", {
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Cache.pipe(
 *   Effect.flatMap((cache) => Stackit.Valkey.Credential("App", { instanceId: cache.instanceId })),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const cache = yield* Stackit.Valkey.ReadWriteValkey(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* cache.incr("visits");
 *         const visits = yield* cache.get("visits");
 *         return yield* HttpServerResponse.json({ visits });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Valkey.ReadWriteValkeyHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** A new name creates a new, empty instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The old instance and its keys are deleted once the new one is up.
 * const cache = yield* Stackit.Valkey.Instance("Cache", {
 *   name: "sessions-v2",
 *   version: "x",
 *   planName: "stackit-keyvalue-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Key Value Store
 * @category Valkey
 */
export const Instance = Resource<Instance>("Stackit.Valkey.Instance");

const parametersOf = (props: InstanceProps): valkey.InstanceParameters =>
  definedParameters({
    ...commonParameters(props),
    maxmemory_policy: props.maxmemoryPolicy,
    maxmemory_samples: props.maxmemorySamples,
    maxclients: props.maxclients,
    notify_keyspace_events: props.notifyKeyspaceEvents,
    snapshot: props.snapshot,
    down_after_milliseconds: props.downAfterMilliseconds,
    failover_timeout: props.failoverTimeout,
    lazyfree_lazy_eviction: props.lazyfreeLazyEviction,
    lazyfree_lazy_expire: props.lazyfreeLazyExpire,
    lua_time_limit: props.luaTimeLimit,
    min_replicas_to_write: props.minReplicasToWrite,
    min_replicas_max_lag: props.minReplicasMaxLag,
    repl_backlog_size: props.replBacklogSize,
  });

export const InstanceProvider = () => {
  const lifecycle = makeInstanceLifecycle<
    ValkeyError,
    valkey.StackitOpContext,
    valkey.InstanceParameters,
    InstanceProps,
    InstanceAttributes
  >({
    label: INSTANCE_LABEL,
    api: instanceApi,
    parametersOf,
    attributes: (base) => base,
  });

  return Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region", "name"],
    // Nuke ordering: `Credential` declares a dependency on this type, so it goes first.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      return yield* lifecycle.list({ projectId: env.projectId, region: env.region });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Everything but the identity updates in place (engine default: props changed).
      return yield* lifecycle.diffIdentity(news, output);
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      return yield* lifecycle.read({ id, olds, output, previous });
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      return yield* lifecycle.reconcile({ id, news, olds, output });
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* lifecycle.delete(output);
    }),
  });
};
