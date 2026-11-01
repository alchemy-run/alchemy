import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  generatedInstanceName,
  getInstance,
  getInstanceOrUndefined,
  INSTANCE_DELETE_TIMEOUT,
  INSTANCE_TIMEOUT,
  listGeneratedInstances,
  listInstanceSummaries,
  requireId,
  type MongoScope,
  type ObservedInstance,
} from "./internal.ts";

/** How the instance's nodes are arranged. */
export type InstanceType = "Single" | "Replica" | "Sharded";

export interface InstanceStorage {
  /**
   * Performance class, e.g. `premium-perf2-mongodb`. The API's `listStorages` lists a
   * flavor's classes. STACKIT's spec says it rejects changing the class from November
   * 2026, so changing it replaces the instance.
   */
  class: string;
  /** Storage size in GB. Updates in place. */
  size: number;
}

export interface InstanceProps {
  /**
   * Name of the instance, 3-63 characters: letters, digits, `-` and `_`, starting with a
   * letter or `_` and not ending with `-`. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Flavor id, `<cpu>.<ram>` as in `2.4`. The API's `listFlavors` lists what a project
   * can use. Updates in place.
   */
  flavorId: string;
  /** MongoDB version, e.g. `7.0`. Updates in place. */
  version: string;
  /** Number of nodes, e.g. `3`. Changing it replaces the instance. */
  replicas: number;
  /** How the nodes are arranged. Changing it replaces the instance. */
  type: InstanceType;
  /** Storage class and size. */
  storage: InstanceStorage;
  /**
   * IP ranges allowed to connect, e.g. `203.0.113.7/32`. Anything else can't open a
   * connection, including any host using `Stackit.MongoDBFlex.Connect`. Updates in place.
   */
  acl: string[];
  /** Cron schedule of the backup in UTC, e.g. `0 2 * * *`. Updates in place. */
  backupSchedule: string;
  /** Days to keep snapshots. Updates in place; omit it to leave the live value alone. */
  snapshotRetentionDays?: number;
  /** Days to keep daily snapshots. Updates in place; omit it to leave the live value alone. */
  dailySnapshotRetentionDays?: number;
  /** Weeks to keep weekly snapshots. Updates in place; omit it to leave the live value alone. */
  weeklySnapshotRetentionWeeks?: number;
  /** Months to keep monthly snapshots. Updates in place; omit it to leave the live value alone. */
  monthlySnapshotRetentionMonths?: number;
  /** Hours of point-in-time recovery. Updates in place; omit it to leave the live value alone. */
  pointInTimeWindowHours?: number;
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
  /** Flavor id. */
  flavorId: string | undefined;
  /** MongoDB version. */
  version: string | undefined;
  /** Number of nodes. */
  replicas: number | undefined;
  /** How the nodes are arranged. */
  type: string | undefined;
  /** Performance class of the storage. */
  storageClass: string | undefined;
  /** Storage size in GB. */
  storageSize: number | undefined;
  /** IP ranges allowed to connect. */
  acl: string[];
  /** Cron schedule of the backup in UTC. */
  backupSchedule: string | undefined;
  /** Days to keep snapshots. */
  snapshotRetentionDays: number | undefined;
  /** Days to keep daily snapshots. */
  dailySnapshotRetentionDays: number | undefined;
  /** Weeks to keep weekly snapshots. */
  weeklySnapshotRetentionWeeks: number | undefined;
  /** Months to keep monthly snapshots. */
  monthlySnapshotRetentionMonths: number | undefined;
  /** Hours of point-in-time recovery. */
  pointInTimeWindowHours: number | undefined;
  /** Instance status; `READY` after a deploy. */
  status: string | undefined;
}

export type Instance = Resource<
  "Stackit.MongoDBFlex.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A managed MongoDB instance on STACKIT MongoDB Flex. Users are a separate resource,
 * `Stackit.MongoDBFlex.User`.
 *
 * Name, flavor, version, storage size, ACL, backup schedule and retention update in
 * place. Project, region, replicas, type and storage class replace the instance, and a
 * replacement starts empty: back up what you need first. Deploys wait until the instance
 * reports `READY`, which takes minutes.
 *
 * Only addresses in `acl` can connect. There is no data API, so anything talking to
 * MongoDB needs a route: put your hosts' public IPs in the ACL as `/32`.
 *
 * STACKIT's API returns no labels for these instances, so ownership is the instance id
 * in state plus the generated name. An instance found without state is ours when it
 * carries this generation's generated name. Under an explicit name it is reported as
 * unowned and only taken over with `--adopt`. `alchemy unsafe nuke` enumerates instances
 * by the shape of a generated name, so give a hand-made instance a name outside it.
 *
 * Instances are billed per started hour by flavor and node count, plus storage and
 * backups.
 *
 * ### Creating an Instance
 * **Example:** A three-node replica set
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 * ```
 *
 * **Example:** A chosen name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.MongoDBFlex.Instance("Db", {
 *   name: "orders-production",
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 50 },
 *   acl: ["203.0.113.0/24"],
 *   backupSchedule: "0 2 * * *",
 * });
 * ```
 *
 * ### Backups and Retention
 * **Example:** Keep snapshots longer
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 *   snapshotRetentionDays: 4,
 *   dailySnapshotRetentionDays: 3,
 *   pointInTimeWindowHours: 30,
 * });
 * ```
 *
 * ### Adding Users
 * **Example:** An instance with a user on one database
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 3,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 * const user = yield* Stackit.MongoDBFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   database: "app",
 *   roles: ["readWrite"],
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the node count creates a new, empty instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The old instance and its data are deleted, so move data out first. An explicit
 * // `name` makes the replacement delete the old instance before it creates the new
 * // one, because the name can't be held twice.
 * const instance = yield* Stackit.MongoDBFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "7.0",
 *   replicas: 5,
 *   type: "Replica",
 *   storage: { class: "premium-perf2-mongodb", size: 10 },
 *   acl: ["203.0.113.7/32"],
 *   backupSchedule: "0 2 * * *",
 * });
 * ```
 *
 * @resource
 * @product STACKIT MongoDB Flex
 * @category MongoDBFlex
 */
export const Instance = Resource<Instance>("Stackit.MongoDBFlex.Instance");

/**
 * The retention settings. `getInstance` reports them as strings in `options`, under
 * these keys, and `updateBackupSchedule` takes them as numbers.
 */
const RETENTION_KEYS = [
  "snapshotRetentionDays",
  "dailySnapshotRetentionDays",
  "weeklySnapshotRetentionWeeks",
  "monthlySnapshotRetentionMonths",
  "pointInTimeWindowHours",
] as const;

type Retention = { [K in (typeof RETENTION_KEYS)[number]]: number | undefined };

const observedRetention = (instance: ObservedInstance): Retention => {
  const read = (key: (typeof RETENTION_KEYS)[number]) => {
    const raw = instance.options?.[key];
    const value = raw === undefined ? Number.NaN : Number(raw);
    return Number.isNaN(value) ? undefined : value;
  };
  return {
    snapshotRetentionDays: read("snapshotRetentionDays"),
    dailySnapshotRetentionDays: read("dailySnapshotRetentionDays"),
    weeklySnapshotRetentionWeeks: read("weeklySnapshotRetentionWeeks"),
    monthlySnapshotRetentionMonths: read("monthlySnapshotRetentionMonths"),
    pointInTimeWindowHours: read("pointInTimeWindowHours"),
  };
};

const toAttrs = (
  scope: MongoScope,
  instance: ObservedInstance,
  // What `updateBackupSchedule` just answered, ahead of a read that may still lag.
  schedule?: mongodb.BackupSchedule,
): InstanceAttributes => {
  const retention = observedRetention(instance);
  return {
    instanceId: instance.id,
    projectId: scope.projectId,
    region: scope.region,
    name: instance.name,
    flavorId: instance.flavor?.id,
    version: instance.version,
    replicas: instance.replicas,
    type: instance.options?.type,
    storageClass: instance.storage?.class,
    storageSize: instance.storage?.size,
    acl: [...(instance.acl?.items ?? [])],
    backupSchedule: schedule?.backupSchedule ?? instance.backupSchedule,
    snapshotRetentionDays: schedule?.snapshotRetentionDays ?? retention.snapshotRetentionDays,
    dailySnapshotRetentionDays:
      schedule?.dailySnapshotRetentionDays ?? retention.dailySnapshotRetentionDays,
    weeklySnapshotRetentionWeeks:
      schedule?.weeklySnapshotRetentionWeeks ?? retention.weeklySnapshotRetentionWeeks,
    monthlySnapshotRetentionMonths:
      schedule?.monthlySnapshotRetentionMonths ?? retention.monthlySnapshotRetentionMonths,
    pointInTimeWindowHours: schedule?.pointInTimeWindowHours ?? retention.pointInTimeWindowHours,
    status: instance.status,
  };
};

/**
 * Compare cron schedules without leading zeros, so `00 02 * * *` is in sync with
 * `0 2 * * *`. STACKIT's Terraform provider does the same: this API answers `00 6 * * *`
 * with `0 6 * * *`.
 */
const simplifyCron = (schedule: string) =>
  schedule
    .trim()
    .split(/\s+/)
    .map((field) => field.replace(/^0+(?=\d)/, ""))
    .join(" ");

/** The instance with this name, in full. Names are unique in a project and region. */
const findInstanceByName = (scope: MongoScope, name: string) =>
  Effect.gen(function* () {
    const summaries = yield* listInstanceSummaries(scope);
    const summary = summaries.find((candidate) => candidate.name === name);
    return summary?.id === undefined ? undefined : yield* getInstanceOrUndefined(scope, summary.id);
  });

const isInFlight = (status: string | undefined) => status === "PENDING" || status === "PROCESSING";

/** Wait until the instance is `READY` and `applied` holds, for a change just sent. */
const waitForInstance = (
  scope: MongoScope,
  instanceId: string,
  applied: (instance: ObservedInstance) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT MongoDB Flex instance ${instanceId}`,
    read: getInstance(scope, instanceId),
    ready: (instance) => instance.status === "READY" && applied(instance),
    // The SDK's wait handlers only treat `FAILED` as final. `UNKNOWN` means the status
    // couldn't be verified, so the budget decides.
    failed: (instance) => (instance.status === "FAILED" ? instance.status : undefined),
    state: (instance) => instance.status,
    timeout: INSTANCE_TIMEOUT,
    maxInterval: "15 seconds",
  });

const waitForInstanceGone = (
  scope: MongoScope,
  instanceId: string,
  failed: (status: string | undefined) => boolean,
) =>
  waitUntilGone({
    resource: `STACKIT MongoDB Flex instance ${instanceId}`,
    read: getInstanceOrUndefined(scope, instanceId),
    state: (instance) => instance.status,
    failed: (instance) => (failed(instance.status) ? (instance.status ?? "unknown") : undefined),
    timeout: INSTANCE_DELETE_TIMEOUT,
    maxInterval: "15 seconds",
  });

type InstancePatch = Pick<
  mongodb.PartialUpdateInstanceRequest,
  "name" | "flavorId" | "version" | "storage" | "acl"
>;

/**
 * The delta between an observed instance and the desired props (empty when in sync).
 * The backup schedule goes through `updateBackupSchedule` with the retention settings.
 */
const instanceDelta = (
  instance: ObservedInstance,
  news: InstanceProps,
  name: string,
): InstancePatch => {
  const patch: InstancePatch = {};
  if (instance.name !== name) patch.name = name;
  if (instance.flavor?.id !== news.flavorId) patch.flavorId = news.flavorId;
  if (instance.version !== news.version) patch.version = news.version;
  if (instance.storage?.size !== news.storage.size) patch.storage = { size: news.storage.size };
  if (!sameMembers(instance.acl?.items, news.acl)) patch.acl = { items: [...news.acl] };
  return patch;
};

type BackupPayload = Omit<
  mongodb.UpdateBackupScheduleRequest,
  "projectId" | "region" | "instanceId"
>;

/**
 * The full `updateBackupSchedule` body when the instance drifted from the desired
 * schedule or retention, otherwise `undefined`. STACKIT's Terraform provider notes that
 * this PUT needs every field, so an unset prop sends what is live.
 */
const backupDelta = (
  instance: ObservedInstance,
  news: InstanceProps,
): BackupPayload | undefined => {
  const live = observedRetention(instance);
  const desired = {
    backupSchedule: news.backupSchedule,
    snapshotRetentionDays: news.snapshotRetentionDays ?? live.snapshotRetentionDays,
    dailySnapshotRetentionDays: news.dailySnapshotRetentionDays ?? live.dailySnapshotRetentionDays,
    weeklySnapshotRetentionWeeks:
      news.weeklySnapshotRetentionWeeks ?? live.weeklySnapshotRetentionWeeks,
    monthlySnapshotRetentionMonths:
      news.monthlySnapshotRetentionMonths ?? live.monthlySnapshotRetentionMonths,
    pointInTimeWindowHours: news.pointInTimeWindowHours ?? live.pointInTimeWindowHours,
  };
  const inSync =
    simplifyCron(instance.backupSchedule ?? "") === simplifyCron(news.backupSchedule) &&
    RETENTION_KEYS.every((key) => desired[key] === live[key]);
  return inSync ? undefined : desired;
};

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region", "storageClass", "replicas", "type"],
    // Nuke ordering: `User` declares a dependency on this type, so it goes first.

    // No labels to filter by, so this matches the shape of a generated name.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listGeneratedInstances(scope);
      return instances.map((instance) => toAttrs(scope, instance));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      const explicitName = rawProp<InstanceProps>(news, "name");
      const storageClass = (
        rawProp<InstanceProps>(news, "storage") as { class?: unknown } | undefined
      )?.class;
      // An unresolved value can resolve to what the instance already has, and an
      // explicit name can't be held twice: the old instance has to go first. A generated
      // name carries the new generation's id, so the new instance can come up first.
      if (
        !isResolved(storageClass) ||
        hasUnresolvedTrigger<InstanceProps>(news, ["projectId", "region", "replicas", "type"])
      ) {
        return { action: "replace", deleteFirst: explicitName !== undefined } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      // Another project or region has its own names, so nothing collides there.
      if (scope.projectId !== output.projectId || scope.region !== output.region) {
        return { action: "replace", deleteFirst: false } as const;
      }
      if (
        // A value the API doesn't report is unknown, not different.
        (output.replicas !== undefined && resolved.replicas !== output.replicas) ||
        (output.type !== undefined && resolved.type !== output.type) ||
        (output.storageClass !== undefined && resolved.storage.class !== output.storageClass)
      ) {
        return {
          action: "replace",
          // A new explicit name doesn't collide with the old instance. An unresolved one
          // can still resolve to the name the old instance holds.
          deleteFirst:
            explicitName !== undefined &&
            (!isResolved(explicitName) || explicitName === output.name),
        } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.instanceId !== undefined) {
        const byId = yield* getInstanceOrUndefined(scope, output.instanceId);
        if (byId !== undefined) return toAttrs(scope, byId);
      }
      const generated = yield* generatedInstanceName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const found = yield* findInstanceByName(scope, name);
      if (found === undefined) return undefined;
      const attrs = toAttrs(scope, found);
      // A generated name holds this generation's instance id, so it is ours. An explicit
      // name proves nothing without labels, unless it is the generation being replaced.
      if (name === generated) return attrs;
      const isPrevious =
        previous?.instanceId === found.id &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const generated = yield* generatedInstanceName(id);
      const name = news.name ?? output?.name ?? generated;

      // 1. Observe — `output` is a cache for the id, and only names the desired instance
      // while it sits in the same project and region. Without it, only this generation's
      // generated name can be claimed: a crashed create. A same-named instance under an
      // explicit name is never taken over here.
      let current: ObservedInstance | undefined;
      if (
        output?.instanceId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getInstanceOrUndefined(scope, output.instanceId);
      }
      if (current === undefined && name === generated) {
        current = yield* findInstanceByName(scope, name);
      }

      // 2. Ensure
      if (current === undefined) {
        const created = yield* mongodb.createInstance({
          ...scope,
          name,
          flavorId: news.flavorId,
          version: news.version,
          replicas: news.replicas,
          storage: { class: news.storage.class, size: news.storage.size },
          acl: { items: [...news.acl] },
          backupSchedule: news.backupSchedule,
          options: { type: news.type },
        });
        const createdId = yield* requireId("createInstance", created.id);
        // The SDK's create handler sleeps as long before its first read. An instance
        // this new may not be readable yet: the 404 clears by itself.
        yield* Effect.sleep("5 seconds");
        current = yield* waitForInstance(scope, createdId).pipe(
          Effect.retry({
            while: (error) => error._tag === "NotFound",
            schedule: Schedule.spaced("5 seconds"),
            times: 12,
          }),
        );
      } else if (current.status !== "READY") {
        current = yield* waitForInstance(scope, current.id);
      }
      const liveId = current.id;

      // 3. Sync — one PATCH with every drifted aspect, diffed against the observed
      // instance. Waiting for the new values too means a read from before the PATCH
      // can't pass.
      const delta = instanceDelta(current, news, name);
      if (Object.keys(delta).length > 0) {
        yield* mongodb.partialUpdateInstance({ ...scope, instanceId: liveId, ...delta });
        current = yield* waitForInstance(
          scope,
          liveId,
          (observed) => Object.keys(instanceDelta(observed, news, name)).length === 0,
        );
      }

      let schedule: mongodb.BackupSchedule | undefined;
      const backup = backupDelta(current, news);
      if (backup !== undefined) {
        schedule = yield* mongodb.updateBackupSchedule({
          ...scope,
          instanceId: liveId,
          ...backup,
        });
        current = yield* waitForInstance(scope, liveId);
      }

      // 4. Return
      return toAttrs(scope, current, schedule);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      let current = yield* getInstanceOrUndefined(scope, output.instanceId);
      if (current === undefined) return;
      // A change in flight (an interrupted deploy) settles first. Settling can end in any
      // state, and a failed instance can still be deleted.
      if (isInFlight(current.status)) {
        current = yield* waitFor({
          resource: `STACKIT MongoDB Flex instance ${output.instanceId}`,
          read: getInstance(scope, output.instanceId),
          ready: (observed) => !isInFlight(observed.status),
          state: (observed) => observed.status,
          timeout: INSTANCE_TIMEOUT,
          maxInterval: "15 seconds",
        }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (current === undefined) return;
      }
      const alreadyFailed = current.status === "FAILED";
      yield* mongodb
        .deleteInstance({ ...scope, instanceId: current.id })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      // The SDK's delete handler fails on `FAILED`. An instance that was in it before the
      // delete can sit there until it's gone, so the budget decides.
      yield* waitForInstanceGone(
        scope,
        current.id,
        (status) => status === "FAILED" && !alreadyFailed,
      );
      // STACKIT's Terraform provider waits as long here: right after the 404, creating an
      // instance with the same name still fails, and a replacement under an explicit name
      // does exactly that.
      yield* Effect.sleep("30 seconds");
    }),
  });
