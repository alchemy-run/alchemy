import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  getInstanceOrUndefined,
  INSTANCE_DELETE_TIMEOUT,
  INSTANCE_TIMEOUT,
  listInstanceSummaries,
  listOwnedInstances,
  type SqlServerScope,
} from "./internal.ts";

/** Who can reach the instance: `PUBLIC`, or `SNA` (airgapped, for enabled accounts). */
export type InstanceAccessScope = "PUBLIC" | "SNA";

export interface InstanceStorage {
  /**
   * Performance class, e.g. `premium-perf2-stackit`. Changing it replaces the
   * instance.
   */
  class: string;
  /** Storage size in GB. Updates in place. */
  size: number;
}

/**
 * Customer key encrypting the instance's storage. Changing it replaces the instance.
 */
export interface InstanceEncryption {
  /** Key id in STACKIT KMS. */
  kekKeyId: string;
  /** Key ring holding the key. */
  kekKeyRingId: string;
  /** Version of the key. */
  kekKeyVersion: string;
  /** Service account linked to the key. */
  serviceAccount: string;
}

export interface InstanceProps {
  /**
   * Name of the instance. Updates in place. Replacing an instance with an explicit
   * name deletes the old one first, since the two would share it.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Flavor id, e.g. `4.16-Single`. `listFlavors` in the API lists what a project can
   * use. Updates in place.
   */
  flavorId: string;
  /** SQL Server version. `2022` is the only one the API lists. Updates in place. */
  version: string;
  /** Storage class and size. */
  storage: InstanceStorage;
  /** Cron schedule of the backup, e.g. `0 2 * * *`. Updates in place. */
  backupSchedule: string;
  /** Days to keep backups, 30 to 90. Updates in place. */
  retentionDays: number;
  /**
   * IPv4 CIDR ranges allowed to connect, e.g. `203.0.113.7/32`. Anything else can't
   * open a connection, including the machine that runs `migrations` and any host
   * using `Stackit.SQLServerFlex.Connect`. Updates in place.
   */
  acl: string[];
  /**
   * Who can reach the instance. `SNA` is only permitted for enabled accounts.
   * Changing it replaces the instance.
   *
   * @default "PUBLIC"
   */
  accessScope?: InstanceAccessScope;
  /** Customer key encrypting the instance. Changing it replaces the instance. */
  encryption?: InstanceEncryption;
  /**
   * Protect the instance from deletion. While it is on, STACKIT refuses a destroy:
   * turn it off with a deploy first. Updates in place; omit it to leave the live
   * setting alone.
   */
  deletionProtection?: boolean;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`,
   * `alchemy.id`, `alchemy.instance`) are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
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
  flavorId: string;
  /** SQL Server version. */
  version: string;
  /** SQL Server edition: `Standard`, `EnterpriseCore` or `developer`. */
  edition: string;
  /** Number of replicas: 1 or 3. */
  replicas: number;
  /** Performance class of the storage. */
  storageClass: string | undefined;
  /** Storage size in GB. */
  storageSize: number | undefined;
  /** Cron schedule of the backup. */
  backupSchedule: string;
  /** Days to keep backups. */
  retentionDays: number;
  /** IPv4 CIDR ranges allowed to connect. */
  acl: string[];
  /** Who can reach the instance. */
  accessScope: string;
  /** Customer key encrypting the instance, if any. */
  encryption: InstanceEncryption | undefined;
  /** Whether the instance can be deleted (`false` while protected). */
  isDeletable: boolean;
  /** Address of the instance in its network, if any. */
  instanceAddress: string | undefined;
  /** Address of the instance's router, if any. */
  routerAddress: string | undefined;
  /** Instance state; `READY` after a deploy. */
  state: string;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type Instance = Resource<
  "Stackit.SQLServerFlex.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A managed Microsoft SQL Server instance on STACKIT SQL Server Flex. Databases and
 * users are separate resources, `Stackit.SQLServerFlex.Database` and
 * `Stackit.SQLServerFlex.User`.
 *
 * Name, flavor, version, storage size, backup schedule, retention, ACL and labels
 * update in place. Project, region, storage class, access scope and encryption
 * replace the instance, and a replacement starts empty: back up what you need first.
 * Deploys wait until the instance reports `READY`, which takes minutes.
 *
 * Only addresses in `acl` can connect. There is no data API, so anything running SQL
 * needs a route: put your deployer's and your hosts' public IPs in the ACL as `/32`.
 *
 * The instance has no host or port attribute, because the API only reports them on a
 * user. Read them from a `Stackit.SQLServerFlex.User`.
 *
 * Ownership is tracked with instance labels. An instance with the same name that
 * lacks them is reported as unowned and only taken over with `--adopt`.
 *
 * Instances are billed per started hour by flavor, plus storage, backups and the SQL
 * Server licence, which makes them expensive to leave running.
 *
 * See [STACKIT's SQL Server Flex docs](https://docs.stackit.cloud/products/databases/sqlserver-flex/).
 *
 * :::caution[Changing `accessScope`, `encryption`, `storage.class`, `projectId` or `region` replaces the Instance]
 * A replacement starts empty: back up what you need first. With an explicit `name`,
 * the old instance is deleted first.
 * :::
 *
 * ### Creating an Instance
 * **Example:** A single-node instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * **Example:** A chosen name and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   name: "orders-production",
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf6-stackit", size: 50 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 90,
 *   acl: ["203.0.113.0/24"],
 *   labels: { env: "production" },
 * });
 * ```
 *
 * ### Protecting an Instance
 * **Example:** Refuse to delete a production instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 *   deletionProtection: true,
 * });
 * ```
 *
 * ### Adding Users and Databases
 * **Example:** An instance with a user that owns a database
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.SQLServerFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 * });
 * const database = yield* Stackit.SQLServerFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   owner: user.userName,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the storage class creates a new, empty instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The old instance and its data are deleted, so move data out first. An explicit
 * // `name` makes the replacement delete the old instance before it creates the
 * // new one.
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf6-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT SQL Server Flex
 * @category SQLServerFlex
 */
export const Instance = Resource<Instance>("Stackit.SQLServerFlex.Instance");

const DEFAULT_ACCESS_SCOPE: InstanceAccessScope = "PUBLIC";

const generatedName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (
  scope: SqlServerScope,
  instance: sqlserver.GetInstanceResponse,
): InstanceAttributes => ({
  instanceId: instance.id,
  projectId: scope.projectId,
  region: scope.region,
  name: instance.name,
  flavorId: instance.flavorId,
  version: instance.version,
  edition: instance.edition,
  replicas: instance.replicas,
  storageClass: instance.storage.class,
  storageSize: instance.storage.size,
  backupSchedule: instance.backupSchedule,
  retentionDays: instance.retentionDays,
  acl: [...(instance.network.acl ?? [])],
  accessScope: instance.network.accessScope ?? DEFAULT_ACCESS_SCOPE,
  encryption: instance.encryption,
  isDeletable: instance.isDeletable,
  instanceAddress: instance.network.instanceAddress,
  routerAddress: instance.network.routerAddress,
  state: instance.state,
  labels: stripInternalLabels(instance.labels),
});

const encryptionKey = (encryption: InstanceEncryption | undefined) =>
  encryption === undefined
    ? undefined
    : JSON.stringify([
        encryption.kekKeyId,
        encryption.kekKeyRingId,
        encryption.kekKeyVersion,
        encryption.serviceAccount,
      ]);

/**
 * Compare cron schedules without leading zeros, so `00 02 * * *` is in sync with
 * `0 2 * * *`. The Terraform provider does the same, because some STACKIT APIs drop
 * them.
 */
const simplifyCron = (schedule: string) =>
  schedule
    .trim()
    .split(/\s+/)
    .map((field) => field.replace(/^0+(?=\d)/, ""))
    .join(" ");

/** The instance with this name, in full, in any state. */
const findInstanceByName = (scope: SqlServerScope, name: string) =>
  Effect.gen(function* () {
    const summaries = yield* listInstanceSummaries(scope);
    const summary = summaries.find((candidate) => candidate.name === name);
    return summary === undefined ? undefined : yield* getInstanceOrUndefined(scope, summary.id);
  });

const isInFlight = (state: string) => state === "PENDING" || state === "PROGRESSING";

/** The SDK's wait handlers treat each of these as final while waiting for `READY`. */
const isFailedState = (state: string) =>
  state === "FAILURE" || state === "UNKNOWN" || state === "TERMINATING";

/** Wait until the instance is `READY` and `applied` holds, for a change just sent. */
const waitForInstance = (
  scope: SqlServerScope,
  instanceId: string,
  applied: (instance: sqlserver.GetInstanceResponse) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT SQL Server Flex instance ${instanceId}`,
    read: sqlserver.getInstance({ ...scope, instanceId }),
    ready: (instance) => instance.state === "READY" && applied(instance),
    failed: (instance) => (isFailedState(instance.state) ? instance.state : undefined),
    state: (instance) => instance.state,
    timeout: INSTANCE_TIMEOUT,
    maxInterval: "15 seconds",
  });

const waitForInstanceGone = (
  scope: SqlServerScope,
  instanceId: string,
  failed: (state: string) => boolean,
) =>
  waitUntilGone({
    resource: `STACKIT SQL Server Flex instance ${instanceId}`,
    read: getInstanceOrUndefined(scope, instanceId),
    state: (instance) => instance.state,
    failed: (instance) => (failed(instance.state) ? instance.state : undefined),
    timeout: INSTANCE_DELETE_TIMEOUT,
    maxInterval: "15 seconds",
  });

type InstancePatch = Omit<
  sqlserver.PartialUpdateInstanceRequest,
  "projectId" | "region" | "instanceId"
>;

/** The delta between an observed instance and the desired props (empty when in sync). */
const instanceDelta = (
  instance: sqlserver.GetInstanceResponse,
  news: InstanceProps,
  name: string,
  labels: Record<string, string>,
): InstancePatch => {
  const patch: InstancePatch = {};
  if (instance.name !== name) patch.name = name;
  if (instance.flavorId !== news.flavorId) patch.flavorId = news.flavorId;
  if (instance.version !== news.version) patch.version = news.version;
  if (instance.storage.size !== news.storage.size) patch.storage = { size: news.storage.size };
  if (simplifyCron(instance.backupSchedule) !== simplifyCron(news.backupSchedule)) {
    patch.backupSchedule = news.backupSchedule;
  }
  if (instance.retentionDays !== news.retentionDays) patch.retentionDays = news.retentionDays;
  if (!sameMembers(instance.network.acl ?? [], news.acl)) patch.network = { acl: [...news.acl] };
  if (labelsChanged(instance.labels, labels)) patch.labels = labels;
  return patch;
};

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region", "storageClass", "accessScope", "encryption"],
    // Nuke ordering: `Database` and `User` declare a dependency on this type, so
    // they go first.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listOwnedInstances(scope);
      return instances.map((instance) => toAttrs(scope, instance));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name survives the replacement, so the old instance has to go
      // first. A generated name carries the new generation's id, so the new instance
      // can come up first.
      const deleteFirst = rawProp<InstanceProps>(news, "name") !== undefined;
      const storageClass = (
        rawProp<InstanceProps>(news, "storage") as { class?: unknown } | undefined
      )?.class;
      if (
        !isResolved(storageClass) ||
        hasUnresolvedTrigger<InstanceProps>(news, [
          "projectId",
          "region",
          "accessScope",
          "encryption",
        ])
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      // Another project or region can't collide with the name.
      if (scope.projectId !== output.projectId || scope.region !== output.region) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Compared with the props last deployed where there are any: the API may answer
      // with a default the props never asked for, or leave an optional value out, and an
      // unchanged deploy must not replace, and so empty, the instance. Only an adoption
      // has nothing but the live values, where a prop that is unset keeps what the
      // instance has, and a value the API doesn't report is unknown, not different.
      const deployedClass = olds?.storage.class ?? output.storageClass;
      const accessScopeChanged =
        olds !== undefined
          ? (resolved.accessScope ?? DEFAULT_ACCESS_SCOPE) !==
            (olds.accessScope ?? DEFAULT_ACCESS_SCOPE)
          : resolved.accessScope !== undefined && resolved.accessScope !== output.accessScope;
      const encryptionChanged =
        olds !== undefined
          ? encryptionKey(resolved.encryption) !== encryptionKey(olds.encryption)
          : resolved.encryption !== undefined &&
            output.encryption !== undefined &&
            encryptionKey(resolved.encryption) !== encryptionKey(output.encryption);
      if (
        (deployedClass !== undefined && resolved.storage.class !== deployedClass) ||
        accessScopeChanged ||
        encryptionChanged
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.instanceId !== undefined) {
        const byId = yield* getInstanceOrUndefined(scope, output.instanceId);
        if (byId !== undefined && byId.state !== "TERMINATING") return toAttrs(scope, byId);
      }
      const name = output?.name ?? olds?.name ?? (yield* generatedName(id));
      const found = yield* findInstanceByName(scope, name);
      if (found === undefined || found.state === "TERMINATING") return undefined;
      const attrs = toAttrs(scope, found);
      if (previous?.instanceId === found.id) return attrs;
      // A crashed create has neither state nor a previous generation, and any
      // generation of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      const owned =
        (yield* hasAlchemyLabels(id, found.labels)) &&
        (generation === undefined || hasInstanceLabel(generation, found.labels));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      // 1. Observe — `output` is a cache for the id, and only names the desired
      // instance while it sits in the same project and region. Without it, only
      // this generation's instance can be claimed: a same-named instance of another
      // generation, or a foreign one, is never taken over here.
      let current: sqlserver.GetInstanceResponse | undefined;
      if (
        output?.instanceId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getInstanceOrUndefined(scope, output.instanceId);
      }
      if (current === undefined) {
        const named = yield* findInstanceByName(scope, name);
        if (
          named !== undefined &&
          (yield* hasAlchemyLabels(id, named.labels)) &&
          hasInstanceLabel(instanceId, named.labels)
        ) {
          current = named;
        }
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "TERMINATING") {
        yield* waitForInstanceGone(scope, current.id, (state) => state === "FAILURE");
        current = undefined;
      }

      // 2. Ensure
      if (current === undefined) {
        const { id: createdId } = yield* sqlserver.createInstance({
          ...scope,
          name,
          flavorId: news.flavorId,
          version: news.version,
          storage: { class: news.storage.class, size: news.storage.size },
          backupSchedule: news.backupSchedule,
          retentionDays: news.retentionDays,
          network: {
            acl: [...news.acl],
            ...(news.accessScope !== undefined ? { accessScope: news.accessScope } : {}),
          },
          labels,
          ...(news.encryption !== undefined ? { encryption: news.encryption } : {}),
        });
        // The Terraform provider sleeps as long before its first read.
        yield* Effect.sleep("30 seconds");
        current = yield* waitForInstance(scope, createdId);
      } else if (current.state !== "READY") {
        current = yield* waitForInstance(scope, current.id);
      }
      const liveId = current.id;

      // 3. Sync — one PATCH with every drifted aspect, diffed against the observed
      // instance. Waiting for the new values too means a read from before the PATCH
      // can't pass. Label removals aren't awaited: whether a PATCH replaces or
      // merges the map is undocumented, and a merge must not stall the deploy.
      const delta = instanceDelta(current, news, name, labels);
      if (Object.keys(delta).length > 0) {
        yield* sqlserver.partialUpdateInstance({ ...scope, instanceId: liveId, ...delta });
        current = yield* waitForInstance(scope, liveId, (observed) => {
          const { labels: _labels, ...rest } = instanceDelta(observed, news, name, labels);
          return Object.keys(rest).length === 0;
        });
      }

      const isDeletable =
        news.deletionProtection === undefined ? undefined : !news.deletionProtection;
      if (isDeletable !== undefined && current.isDeletable !== isDeletable) {
        yield* sqlserver.updateInstanceProtection({ ...scope, instanceId: liveId, isDeletable });
        current = yield* waitForInstance(
          scope,
          liveId,
          (observed) => observed.isDeletable === isDeletable,
        );
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      let current = yield* getInstanceOrUndefined(scope, output.instanceId);
      if (current === undefined) return;
      if (current.state === "TERMINATING") {
        return yield* waitForInstanceGone(scope, current.id, (state) => state === "FAILURE");
      }
      // A change in flight (an interrupted deploy) settles first. Settling can end
      // in any state, and a failed instance can still be deleted.
      if (isInFlight(current.state)) {
        current = yield* waitFor({
          resource: `STACKIT SQL Server Flex instance ${output.instanceId}`,
          read: sqlserver.getInstance({ ...scope, instanceId: output.instanceId }),
          ready: (observed) => !isInFlight(observed.state),
          state: (observed) => observed.state,
          timeout: INSTANCE_TIMEOUT,
          maxInterval: "15 seconds",
        }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (current === undefined) return;
      }
      // Protection is only ever lifted for an explicit `alchemy unsafe nuke`. A
      // normal destroy surfaces the API's refusal.
      if (force && !current.isDeletable) {
        yield* sqlserver.updateInstanceProtection({
          ...scope,
          instanceId: current.id,
          isDeletable: true,
        });
      }
      const alreadyFailed = current.state === "FAILURE";
      yield* sqlserver
        .deleteInstance({ ...scope, instanceId: current.id })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      // The SDK's delete handler fails on `FAILURE`. An instance that was in it
      // before the delete can sit there until it's gone, so the budget decides.
      yield* waitForInstanceGone(
        scope,
        current.id,
        (state) => state === "FAILURE" && !alreadyFailed,
      );
    }),
  });
