import * as logs from "@distilled.cloud/stackit/logs";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScope, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  diffLabels,
  isAlchemyOwned,
  managedLabels,
  reservedLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findOwned,
  generatedDisplayName,
  getInstanceOrUndefined,
  INSTANCE_TIMEOUT,
  listInstances,
  LOGS_SERVICE_ID,
  scopeRequest,
  userLabels,
} from "./internal.ts";

/** The Alchemy default: the API requires a retention and documents none. */
const DEFAULT_RETENTION_DAYS = 30;

export interface InstanceProps {
  /**
   * Name shown in the STACKIT portal: 1 to 32 characters, starting with a letter, then
   * letters, digits, `_`, `-` and spaces. Updates in place.
   *
   * @default a name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /**
   * How many days logs are kept, from 1 to 180. Updates in place; omit to leave the live
   * value alone, so taking over an instance or removing this prop doesn't shorten what it
   * keeps. A new instance gets the default.
   *
   * @default 30
   */
  retentionDays?: number;
  /**
   * CIDR ranges allowed to reach the instance, at most 30. STACKIT's docs say a client
   * outside the list can't connect. Updates in place; omit to leave the live list
   * alone, so removing this prop does not clear it.
   */
  acl?: string[];
  /**
   * Description, at most 100 characters. Updates in place; omit to leave the live value
   * alone.
   */
  description?: string;
  /**
   * User labels. Alchemy's ownership labels are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /** Project that owns the instance. Changing it replaces the instance. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the instance. @default the profile's region */
  region?: string;
}

export interface InstanceAttributes {
  /** STACKIT instance id (UUID). Stable across updates. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name shown in the STACKIT portal. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** How many days logs are kept. */
  retentionDays: number;
  /** CIDR ranges allowed to reach the instance. */
  acl: string[];
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** `active` after a deploy. */
  status: logs.LogsInstanceStatus;
  /** When the instance's creation was triggered. */
  created: string;
  /** Root URL of the instance, usable as a Grafana Loki data source. */
  datasourceUrl: string | undefined;
  /** URL Loki clients push to. */
  ingestUrl: string | undefined;
  /** URL OTLP clients push to. */
  ingestOtlpUrl: string | undefined;
  /** URL of Loki's instant query endpoint. */
  queryUrl: string | undefined;
  /** URL of Loki's range query endpoint. */
  queryRangeUrl: string | undefined;
}

export type Instance = Resource<
  "Stackit.Logs.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Logs instance: pay-per-use Grafana Loki, billed by ingested and retained
 * data. It isn't the Loki inside `Stackit.Observability.Instance`.
 *
 * Reading or writing logs takes a `Stackit.Logs.AccessToken`, and a client has to be in
 * the instance's `acl` to connect. The first deploy enables the Logs service
 * (`cloud.stackit.logs`) for the project and waits for the instance to report `active`.
 *
 * Changing `projectId` or `region` replaces the instance, and the logs it holds are not
 * carried over. Everything else updates in place.
 *
 * Ownership is tracked with STACKIT labels. An instance with the same `displayName`
 * that lacks them is reported as unowned and only taken over with `--adopt`.
 *
 * ### Creating an Instance
 * **Example:** An instance with a 30 day retention
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.Logs.Instance("Logs", {
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * ### Configuring the Instance
 * **Example:** Name, retention, description and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.Logs.Instance("Logs", {
 *   displayName: "orders-logs",
 *   retentionDays: 90,
 *   description: "Order service logs",
 *   acl: ["203.0.113.7/32"],
 *   labels: { team: "orders" },
 * });
 * ```
 *
 * ### Pushing and Querying Logs
 * **Example:** Push a line and query it from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 * export const Token = Logs.pipe(
 *   Effect.flatMap((logs) =>
 *     Stackit.Logs.AccessToken("Token", {
 *       instanceId: logs.instanceId,
 *       permissions: ["read", "write"],
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const logs = yield* Stackit.Logs.ReadWriteInstance(yield* Token);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* logs.push({
 *           streams: [{ stream: { app: "api" }, values: [[`${Date.now()}000000`, "hello"]] }],
 *         });
 *         const found = yield* logs.queryRange({ query: '{app="api"}', since: "5m" });
 *         return yield* HttpServerResponse.json({ streams: found.data.result.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.ReadWriteInstanceHttp)),
 * ) {}
 * ```
 *
 * ### Reading the Instance at Runtime
 * **Example:** Read its status from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getInstance = yield* Stackit.Logs.GetInstance(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const instance = yield* getInstance({});
 *         return yield* HttpServerResponse.json({ status: instance.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving to another region creates a new, empty instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The new instance is created first, and the old one is deleted with its logs.
 * // Access tokens and policies on it are replaced with it.
 * const logs = yield* Stackit.Logs.Instance("Logs", {
 *   region: "eu02",
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Logs
 * @category Logs
 */
export const Instance = Resource<Instance>("Stackit.Logs.Instance");

const toAttrs = (scope: ProjectScope, instance: logs.LogsInstance): InstanceAttributes => ({
  instanceId: instance.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: instance.displayName,
  description: instance.description === "" ? undefined : instance.description,
  retentionDays: instance.retentionDays,
  acl: [...(instance.acl ?? [])],
  labels: userLabels(instance.labels),
  status: instance.status,
  created: instance.created,
  datasourceUrl: instance.datasourceUrl,
  ingestUrl: instance.ingestUrl,
  ingestOtlpUrl: instance.ingestOtlpUrl,
  queryUrl: instance.queryUrl,
  queryRangeUrl: instance.queryRangeUrl,
});

/** `192.0.2.1` and `192.0.2.1/32` are the same range; the API may answer either. */
const normalizeCidrs = (acl: ReadonlyArray<string> | undefined): string[] =>
  (acl ?? []).map((cidr) =>
    cidr.includes("/") ? cidr : `${cidr}/${cidr.includes(":") ? 128 : 32}`,
  );

/** What the instance should hold. An omitted `retentionDays`, `acl` or `description` is left alone. */
interface DesiredInstance {
  readonly displayName: string;
  readonly retentionDays: number | undefined;
  readonly acl: string[] | undefined;
  readonly description: string | undefined;
  readonly labels: Record<string, string>;
}

/** Whether every aspect but a removed label matches. */
const settingsMatch = (instance: logs.LogsInstance, desired: DesiredInstance): boolean =>
  instance.displayName === desired.displayName &&
  (desired.retentionDays === undefined || instance.retentionDays === desired.retentionDays) &&
  (desired.acl === undefined ||
    sameMembers(normalizeCidrs(instance.acl), normalizeCidrs(desired.acl))) &&
  (desired.description === undefined || (instance.description ?? "") === desired.description);

const labelsDrifted = (instance: logs.LogsInstance, labels: Record<string, string>): boolean => {
  const { upsert, removed } = diffLabels(managedLabels(instance.labels), labels);
  return upsert.length > 0 || removed.length > 0;
};

/** Wait until the instance is `active`, and `applied` holds. */
const waitForActive = (
  scope: ProjectScope,
  instanceId: string,
  applied: (instance: logs.LogsInstance) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT Logs instance ${instanceId}`,
    read: logs.getLogsInstance({ ...scopeRequest(scope), instanceId }),
    ready: (instance) => instance.status === "active" && applied(instance),
    // The Go SDK's create handler fails on `deleting`, and the API has no failed status.
    failed: (instance) => (instance.status === "deleting" ? instance.status : undefined),
    state: (instance) => instance.status,
    timeout: INSTANCE_TIMEOUT,
    interval: "5 seconds",
    maxInterval: "15 seconds",
  });

const readForGone = (scope: ProjectScope, instanceId: string) =>
  logs
    .getLogsInstance({ ...scopeRequest(scope), instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitForGone = (scope: ProjectScope, instanceId: string) =>
  waitUntilGone({
    resource: `STACKIT Logs instance ${instanceId}`,
    read: readForGone(scope, instanceId),
    state: (instance) => instance.status,
    timeout: INSTANCE_TIMEOUT,
    interval: "5 seconds",
    maxInterval: "15 seconds",
  });

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listInstances(scope);
      return instances
        .filter((instance) => isAlchemyOwned(instance.labels))
        .map((instance) => toAttrs(scope, instance));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved project or region can resolve to the one the instance sits in,
      // and an explicit name may not exist twice there. A generated name carries the
      // generation.
      if (hasUnresolvedTrigger<InstanceProps>(news, ["projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<InstanceProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output !== undefined) {
        const byId = yield* getInstanceOrUndefined(scope, output.instanceId);
        if (byId !== undefined) return toAttrs(scope, byId);
      }
      const instances = yield* listInstances(scope);
      // A crashed create has neither state nor a previous generation, and any
      // generation of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      const owned = yield* findOwned(id, instances, generation);
      if (owned !== undefined) return toAttrs(scope, owned);
      // A name is only unique per project and region, so the generation being replaced
      // has to match on all three.
      const name = output?.displayName ?? olds?.displayName;
      const named = instances.find((instance) => instance.displayName === name);
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, named);
      const isPrevious =
        previous?.instanceId === named.id &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const request = scopeRequest(scope);
      const desired: DesiredInstance = {
        displayName: news.displayName ?? (yield* generatedDisplayName(id)),
        retentionDays: news.retentionDays,
        acl: news.acl,
        description: news.description,
        labels: yield* desiredGenerationLabels(id, instanceId, news.labels),
      };

      yield* ensureServiceEnabled({ ...scope, serviceId: LOGS_SERVICE_ID });

      // 1. Observe — `output` is a cache for the id, and only names the desired
      // instance while it sits in the same project and region. Without it, only this
      // generation's labels can claim an instance.
      let current: logs.LogsInstance | undefined;
      if (output?.projectId === scope.projectId && output.region === scope.region) {
        current = yield* readForGone(scope, output.instanceId);
      }
      if (current === undefined) {
        const { instances } = yield* logs.listLogsInstances(request);
        current = yield* findOwned(id, instances, instanceId);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.status === "deleting") {
        yield* waitForGone(scope, current.id);
        current = undefined;
      }

      // 2. Ensure
      if (current === undefined) {
        current = yield* logs.createLogsInstance({
          ...request,
          displayName: desired.displayName,
          retentionDays: desired.retentionDays ?? DEFAULT_RETENTION_DAYS,
          labels: desired.labels,
          ...(desired.acl !== undefined ? { acl: [...desired.acl] } : {}),
          ...(desired.description !== undefined ? { description: desired.description } : {}),
        });
      }
      const liveId = current.id;
      if (current.status !== "active") current = yield* waitForActive(scope, liveId);

      // 3. Sync — PUT reads as a full replacement, and whether it clears an omitted
      // field is undocumented, so it carries the whole state: the desired aspects, and
      // the observed ones the props leave alone.
      if (!settingsMatch(current, desired) || labelsDrifted(current, desired.labels)) {
        const acl = desired.acl ?? current.acl;
        const description = desired.description ?? current.description;
        yield* logs
          .updateLogsInstance({
            ...request,
            instanceId: liveId,
            displayName: desired.displayName,
            retentionDays: desired.retentionDays ?? current.retentionDays,
            labels: { ...reservedLabels(current.labels), ...desired.labels },
            ...(acl !== undefined ? { acl: [...acl] } : {}),
            ...(description !== undefined ? { description } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
        // Waiting for the new values means a read from before the PUT can't pass. Label
        // removals aren't awaited: a merge must not stall the deploy.
        current = yield* waitForActive(scope, liveId, (instance) => {
          const observed = managedLabels(instance.labels);
          return (
            settingsMatch(instance, desired) &&
            Object.entries(desired.labels).every(([key, value]) => observed[key] === value)
          );
        });
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId } = output;
      // An instance still reconciling answers a delete with a 409 for as long as it
      // takes, which is longer than the retry below covers.
      yield* waitFor({
        resource: `STACKIT Logs instance ${instanceId}`,
        read: readForGone(scope, instanceId),
        ready: (instance) => instance?.status !== "reconciling",
        state: (instance) => instance?.status,
        timeout: INSTANCE_TIMEOUT,
        interval: "5 seconds",
        maxInterval: "15 seconds",
      });
      yield* logs.deleteLogsInstance({ ...scopeRequest(scope), instanceId }).pipe(
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitForGone(scope, instanceId);
    }),
  });
