import type * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  commonParameters,
  definedParameters,
  INSTANCE_LABEL,
  instanceApi,
  makeInstanceLifecycle,
  type OpenSearchError,
} from "./internal.ts";

/** An OpenSearch plugin the instance can turn on. */
export type InstancePlugin = "repository-s3" | "repository-azure" | "analysis-phonetic";

/** The JVM garbage collector of an instance. */
export type JavaGarbageCollector = "UseSerialGC" | "UseParallelGC" | "UseParallelOldGC" | "UseG1GC";

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
   * Plan name, e.g. `stackit-opensearch-1.2.10-replica`. A deploy fails with
   * `SearchServicePlanNotFound`, listing the choices, when no such plan exists. Updates
   * in place.
   */
  planName: string;
  /**
   * IPv4 CIDR ranges allowed to connect, e.g. `203.0.113.7/32`. Anything else can't
   * open a connection, including any host using this service's data bindings. Updates
   * in place. Leave it unset to keep STACKIT's default ranges.
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
   * Plugins to turn on. `repository-s3` and `repository-azure` are always on and can't
   * be turned off.
   */
  plugins?: InstancePlugin[];
  /**
   * JVM garbage collector.
   *
   * @default "UseG1GC"
   */
  javaGarbageCollector?: JavaGarbageCollector;
  /**
   * Memory the JVM allocates as heap, in MB, at least 256.
   *
   * @default 46% of available memory
   */
  javaHeapspace?: number;
  /**
   * Memory the JVM uses for metadata, in MB, from 256 to 1024.
   *
   * @default 512
   */
  javaMaxmetaspace?: number;
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
  "Stackit.OpenSearch.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A managed OpenSearch instance on STACKIT OpenSearch. Connection details come from a
 * `Stackit.OpenSearch.Credential`.
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
 * See [STACKIT's OpenSearch docs](https://docs.stackit.cloud/products/databases/opensearch/).
 *
 * :::caution[Changing `name`, `projectId` or `region` replaces the Instance]
 * A replacement starts empty: the indexes in the old instance are deleted with it.
 * :::
 *
 * ### Creating an Instance
 * **Example:** A replicated instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const search = yield* Stackit.OpenSearch.Instance("Search", {
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * ### Tuning OpenSearch
 * **Example:** A plugin and the JVM's memory
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const search = yield* Stackit.OpenSearch.Instance("Search", {
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.0/24"],
 *   plugins: ["analysis-phonetic"],
 *   javaGarbageCollector: "UseG1GC",
 *   javaHeapspace: 2048,
 * });
 * ```
 *
 * ### Operating an Instance
 * **Example:** Monitoring, automatic updates and an encryption key for backups
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const search = yield* Stackit.OpenSearch.Instance("Search", {
 *   name: "catalog-production",
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.0/24"],
 *   automaticUpdates: true,
 *   backupEncryptionKey: Redacted.make("a-key-you-manage"),
 *   enableMonitoring: true,
 *   syslog: ["logs.example.com:54321"],
 * });
 * ```
 *
 * ### Searching from a Host
 * **Example:** Index and search documents from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Search = Stackit.OpenSearch.Instance("Search", {
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Search.pipe(
 *   Effect.flatMap((search) =>
 *     Stackit.OpenSearch.Credential("App", { instanceId: search.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const orders = yield* Stackit.OpenSearch.ReadWriteIndex(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* orders.index({
 *           index: "orders",
 *           id: "1",
 *           refresh: "true",
 *           body: { sku: "tea" },
 *         });
 *         const found = yield* orders.search({
 *           index: "orders",
 *           query: { match: { sku: "tea" } },
 *         });
 *         return yield* HttpServerResponse.json({ hits: found.hits.hits.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.OpenSearch.ReadWriteIndexHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** A new name creates a new, empty instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The old instance and its indices are deleted once the new one is up.
 * const search = yield* Stackit.OpenSearch.Instance("Search", {
 *   name: "catalog-v2",
 *   version: "2",
 *   planName: "stackit-opensearch-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT OpenSearch
 * @category OpenSearch
 */
export const Instance = Resource<Instance>("Stackit.OpenSearch.Instance");

const parametersOf = (props: InstanceProps): opensearch.InstanceParameters =>
  definedParameters({
    ...commonParameters(props),
    plugins: props.plugins,
    java_garbage_collector: props.javaGarbageCollector,
    java_heapspace: props.javaHeapspace,
    java_maxmetaspace: props.javaMaxmetaspace,
  });

export const InstanceProvider = () => {
  const lifecycle = makeInstanceLifecycle<
    OpenSearchError,
    opensearch.StackitOpContext,
    opensearch.InstanceParameters,
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
