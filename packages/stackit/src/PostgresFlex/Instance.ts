import * as postgres from "@distilled.cloud/stackit/postgres_flex";
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
  INSTANCE_TIMEOUT,
  instanceLockedRetry,
  listInstanceSummaries,
  listOwnedInstances,
  type PostgresScope,
} from "./internal.ts";

/** Who can reach the instance: `PUBLIC`, or `SNA` (airgapped, for enabled accounts). */
export type InstanceAccessScope = "PUBLIC" | "SNA";

export interface InstanceStorage {
  /**
   * Performance class, e.g. `premium-perf2-stackit`. STACKIT can't change it in
   * place, so changing it replaces the instance.
   */
  class: string;
  /** Storage size in GB. Updates in place. */
  size: number;
}

/**
 * Customer key encrypting the instance's volume and backups. STACKIT only
 * accepts it for enabled accounts. Changing it replaces the instance.
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

/** The instance and point in time a new instance is cloned from. */
export interface InstanceCloneSource {
  /** Id of the instance to clone. */
  instanceId: string;
  /**
   * RFC 3339 time to recover to. STACKIT accepts a time between the source's
   * first and last backup.
   */
  pointInTime: string;
}

export interface InstanceProps {
  /**
   * Name of the instance, 3-63 characters. Updates in place. STACKIT rejects a
   * second instance with the same name, so replacing an instance with an explicit
   * name deletes the old one first.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Flavor id, e.g. `2.4` or `4.8-replica`. `listFlavors` in the API lists what a
   * project can use. Updates in place.
   */
  flavorId: string;
  /** PostgreSQL version, e.g. `17`. Updates in place. */
  version: string;
  /** Storage class and size. */
  storage: InstanceStorage;
  /**
   * Cron schedule of the backup, e.g. `0 2 * * *`. STACKIT only supports daily
   * schedules. Updates in place.
   */
  backupSchedule: string;
  /** Days to keep backups. Updates in place. */
  retentionDays: number;
  /**
   * IPv4 CIDR ranges allowed to connect, e.g. `203.0.113.7/32`. Anything else
   * can't open a connection, including the machine that runs `migrations` and any
   * host using `Stackit.PostgresFlex.Connect`. Updates in place.
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
   * Protect the instance from deletion. While it is on, STACKIT rejects a destroy:
   * turn it off with a deploy first. Updates in place; omit it to leave the live
   * setting alone.
   */
  deletionProtection?: boolean;
  /**
   * Create the instance as a clone of another one, then converge it to these props.
   * Setting or changing it replaces the instance; removing it keeps the instance as
   * it is.
   *
   * STACKIT's clone call takes no labels, so a clone gets Alchemy's labels once it
   * is ready. A generated name still identifies a clone interrupted before then, so
   * the next deploy or destroy picks it up. Under an explicit name such a clone is
   * reported as unowned: redeploy with `--adopt`, or delete it by hand.
   */
  cloneFrom?: InstanceCloneSource;
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
  /** PostgreSQL version. */
  version: string;
  /** Performance class of the storage. */
  storageClass: string | undefined;
  /** Storage size in GB. */
  storageSize: number | undefined;
  /** Cron schedule of the backup. */
  backupSchedule: string;
  /** Days to keep backups. */
  retentionDays: number | null;
  /** IPv4 CIDR ranges allowed to connect. */
  acl: string[];
  /** Who can reach the instance. */
  accessScope: string;
  /** Customer key encrypting the instance, if any. */
  encryption: InstanceEncryption | undefined;
  /** Whether the instance can be deleted (`false` while protected). */
  isDeletable: boolean;
  /** Host to connect to. */
  host: string;
  /** Port to connect to. */
  port: number;
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
  "Stackit.PostgresFlex.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A managed PostgreSQL instance on STACKIT PostgreSQL Flex. Databases and users
 * are separate resources, `Stackit.PostgresFlex.Database` and
 * `Stackit.PostgresFlex.User`.
 *
 * Flavor, version, storage size, backup schedule, retention, ACL and labels update
 * in place. Project, region, storage class, access scope, encryption and the clone
 * source replace the instance, and a replacement starts empty: back up what you
 * need first. Deploys wait until the instance reports `READY`, which takes minutes.
 *
 * Only addresses in `acl` can connect. There is no data API, so anything running
 * SQL needs a route: put your deployer's and your hosts' public IPs in the ACL as
 * `/32`. STACKIT advises against `0.0.0.0/0`.
 *
 * Ownership is tracked with instance labels. An instance with the same name that
 * lacks them is reported as unowned and only taken over with `--adopt`.
 *
 * Instances are billed per started hour by flavor, plus storage and backups.
 *
 * The instance only accepts TLS connections, and only from the ranges in `acl`.
 *
 * See [STACKIT's PostgreSQL Flex docs](https://docs.stackit.cloud/products/databases/postgresql-flex/).
 *
 * :::caution[Changing `accessScope`, `encryption`, `cloneFrom`, `storage.class`, `projectId` or `region` replaces the Instance]
 * A replacement starts empty: back up what you need first. With an explicit `name`,
 * the old instance is deleted first, so the database is down until the new one is
 * `READY`. Removing `cloneFrom` keeps the instance.
 * :::
 *
 * ### Creating an Instance
 * **Example:** A single-node instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * **Example:** A replica flavor with a chosen name and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   name: "orders-production",
 *   flavorId: "4.8-replica",
 *   version: "17",
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
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 *   deletionProtection: true,
 * });
 * ```
 *
 * ### Cloning an Instance
 * **Example:** A new instance from another one's backups
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const source = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const clone = yield* Stackit.PostgresFlex.Instance("Restored", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf4-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 *   cloneFrom: {
 *     instanceId: source.instanceId,
 *     pointInTime: "2026-11-01T02:30:00Z",
 *   },
 * });
 * ```
 *
 * ### Adding Users and Databases
 * **Example:** An instance with a user that owns a database
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.PostgresFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   roles: ["login", "createdb"],
 * });
 * const database = yield* Stackit.PostgresFlex.Database("AppDatabase", {
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
 * // The old instance and its data are deleted, so move data out first, or set
 * // `cloneFrom` on a new logical id to carry it over. An explicit `name` makes
 * // the replacement delete the old instance before it creates the new one.
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf6-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * ```
 *
 * ### Backups and Network Access
 * `acl` is what lets a client connect. Anything outside it times out, including a host
 * using `Stackit.PostgresFlex.Connect`.
 *
 * **Example:** A nightly backup kept for two weeks, reachable from one range
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const db = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 14,
 *   acl: ["203.0.113.0/24"],
 * });
 * ```
 *
 * ### Encrypting with Your Own Key
 * STACKIT only accepts `encryption` for enabled accounts. Changing it replaces the instance.
 *
 * **Example:** Encrypt the volume and backups with a KMS key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const db = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 *   encryption: {
 *     kekKeyId: "00000000-0000-0000-0000-000000000001",
 *     kekKeyRingId: "00000000-0000-0000-0000-000000000002",
 *     kekKeyVersion: "1",
 *     serviceAccount: "kms-user@sa.stackit.cloud",
 *   },
 * });
 * ```
 *
 * ### Binding to a Runtime
 * `Connect` passes the host, port, names and password into the host's environment, with
 * the password kept `Redacted`. It grants no STACKIT role, because connections
 * authenticate with the database user. The host's egress address has to be in `acl`.
 *
 * **Example:** Resolve the connection URL from a Function
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * export const AppUser = Db.pipe(
 *   Effect.flatMap((db) => Stackit.PostgresFlex.User("AppUser", { instanceId: db.instanceId })),
 * );
 * export const AppDatabase = Effect.gen(function* () {
 *   const db = yield* Db;
 *   const user = yield* AppUser;
 *   return yield* Stackit.PostgresFlex.Database("AppDatabase", {
 *     instanceId: db.instanceId,
 *     owner: user.userName,
 *   });
 * });
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     const database = yield* AppDatabase;
 *     const user = yield* AppUser;
 *     const connect = yield* Stackit.PostgresFlex.Connect(database, user);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const info = yield* connect;
 *         return yield* HttpServerResponse.json({ host: info.host, database: info.database });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PostgresFlex.ConnectHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * `ReadWriteInstance` grants a custom role on the project holding the instance, with the
 * read permissions and `postgres-flex.user.reset`. STACKIT binds roles on projects at the
 * narrowest, so it reaches every PostgreSQL Flex instance in that project.
 *
 * **Example:** List users and rotate a password
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Stackit.Functions.Function<Api>()(
 *   "Api",
 *   {
 *     main: import.meta.url,
 *     registry: { repository: "ghcr.io/my-org/api" },
 *   },
 *   Effect.gen(function* () {
 *     const client = yield* Stackit.PostgresFlex.ReadWriteInstance(yield* Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { users } = yield* client.listUsers();
 *         const { name } = yield* client.resetUserPassword({ userId: users[0]!.id });
 *         return yield* HttpServerResponse.json({ rotated: name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PostgresFlex.ReadWriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT PostgreSQL Flex
 * @category PostgresFlex
 */
export const Instance = Resource<Instance>("Stackit.PostgresFlex.Instance");

const DEFAULT_ACCESS_SCOPE: InstanceAccessScope = "PUBLIC";

const generatedName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (
  scope: PostgresScope,
  instance: postgres.GetInstanceResponse,
): InstanceAttributes => ({
  instanceId: instance.id,
  projectId: scope.projectId,
  region: scope.region,
  name: instance.name,
  flavorId: instance.flavorId,
  version: instance.version,
  storageClass: instance.storage.class,
  storageSize: instance.storage.size,
  backupSchedule: instance.backupSchedule,
  retentionDays: instance.retentionDays,
  acl: [...instance.network.acl],
  accessScope: instance.network.accessScope ?? DEFAULT_ACCESS_SCOPE,
  encryption: instance.encryption,
  isDeletable: instance.isDeletable,
  host: instance.connectionInfo.write.host,
  port: instance.connectionInfo.write.port,
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

const cloneKey = (source: InstanceCloneSource | undefined) =>
  source === undefined ? undefined : JSON.stringify([source.instanceId, source.pointInTime]);

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

/** The instance with this name, in full, in any state. Names are unique in a project. */
const findInstanceByName = (scope: PostgresScope, name: string) =>
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
  scope: PostgresScope,
  instanceId: string,
  applied: (instance: postgres.GetInstanceResponse) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT PostgreSQL Flex instance ${instanceId}`,
    read: postgres.getInstance({ ...scope, instanceId }),
    ready: (instance) => instance.state === "READY" && applied(instance),
    failed: (instance) => (isFailedState(instance.state) ? instance.state : undefined),
    state: (instance) => instance.state,
    timeout: INSTANCE_TIMEOUT,
    maxInterval: "15 seconds",
  });

const waitForInstanceGone = (
  scope: PostgresScope,
  instanceId: string,
  failed: (state: string) => boolean,
) =>
  waitUntilGone({
    resource: `STACKIT PostgreSQL Flex instance ${instanceId}`,
    read: getInstanceOrUndefined(scope, instanceId),
    state: (instance) => instance.state,
    failed: (instance) => (failed(instance.state) ? instance.state : undefined),
    timeout: INSTANCE_TIMEOUT,
    maxInterval: "15 seconds",
  });

type InstancePatch = Omit<
  postgres.PartialUpdateInstanceRequest,
  "projectId" | "region" | "instanceId"
>;

/** The delta between an observed instance and the desired props (empty when in sync). */
const instanceDelta = (
  instance: postgres.GetInstanceResponse,
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
  if (!sameMembers(instance.network.acl, news.acl)) patch.network = { acl: [...news.acl] };
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
      // Names are unique in a project, and an explicit one survives the
      // replacement: the old instance has to go first. A generated name carries
      // the new generation's id, so the new instance can come up first.
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
          "cloneFrom",
        ])
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
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
        scope.projectId !== output.projectId ||
        scope.region !== output.region ||
        (deployedClass !== undefined && resolved.storage.class !== deployedClass) ||
        accessScopeChanged ||
        encryptionChanged ||
        // Removing `cloneFrom` keeps the data; only a new source replaces.
        (olds !== undefined &&
          resolved.cloneFrom !== undefined &&
          cloneKey(resolved.cloneFrom) !== cloneKey(olds.cloneFrom))
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
      // A generated name holds this generation's instance id, so it is ours even
      // unlabelled: a clone only gets its labels from the PATCH after it is ready.
      if (name === (yield* generatedName(id))) return attrs;
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
      const generated = yield* generatedName(id);
      const name = news.name ?? output?.name ?? generated;
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      // A generated name holds this generation's instance id, which covers a clone
      // a crash left without labels. An explicit name needs them.
      const isThisGeneration = (found: postgres.GetInstanceResponse) =>
        Effect.gen(function* () {
          if (name === generated) return true;
          return (
            (yield* hasAlchemyLabels(id, found.labels)) &&
            hasInstanceLabel(instanceId, found.labels)
          );
        });

      // 1. Observe — `output` is a cache for the id, and only names the desired
      // instance while it sits in the same project and region. Without it, only
      // this generation's instance can be claimed: a same-named instance of another
      // generation, or a foreign one, is never taken over here.
      let current: postgres.GetInstanceResponse | undefined;
      if (
        output?.instanceId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getInstanceOrUndefined(scope, output.instanceId);
      }
      if (current === undefined) {
        const named = yield* findInstanceByName(scope, name);
        if (named !== undefined && (yield* isThisGeneration(named))) {
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
        const { id: createdId } = news.cloneFrom
          ? yield* postgres
              .cloneInstance({
                ...scope,
                instanceId: news.cloneFrom.instanceId,
                pointInTime: news.cloneFrom.pointInTime,
                instanceOverrides: {
                  class: news.storage.class,
                  size: news.storage.size,
                  name,
                },
              })
              .pipe(
                // Lost a race against our own create: observe it. Anything else
                // holding the name is not ours, and still fails.
                Effect.catchTag("Conflict", (error) =>
                  Effect.gen(function* () {
                    const found = yield* findInstanceByName(scope, name);
                    return found !== undefined && (yield* isThisGeneration(found))
                      ? { id: found.id }
                      : yield* Effect.fail(error);
                  }),
                ),
              )
          : yield* postgres.createInstance({
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
        // The SDK's create handler sleeps as long before its first read.
        yield* Effect.sleep("15 seconds");
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
        yield* postgres
          .partialUpdateInstance({ ...scope, instanceId: liveId, ...delta })
          .pipe(Effect.retry(instanceLockedRetry));
        current = yield* waitForInstance(scope, liveId, (observed) => {
          const { labels: _labels, ...rest } = instanceDelta(observed, news, name, labels);
          return Object.keys(rest).length === 0;
        });
      }

      const isDeletable =
        news.deletionProtection === undefined ? undefined : !news.deletionProtection;
      if (isDeletable !== undefined && current.isDeletable !== isDeletable) {
        yield* postgres.updateInstanceProtection({ ...scope, instanceId: liveId, isDeletable });
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
          resource: `STACKIT PostgreSQL Flex instance ${output.instanceId}`,
          read: postgres.getInstance({ ...scope, instanceId: output.instanceId }),
          ready: (observed) => !isInFlight(observed.state),
          state: (observed) => observed.state,
          timeout: INSTANCE_TIMEOUT,
          maxInterval: "15 seconds",
        }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (current === undefined) return;
      }
      // Protection is only ever lifted for an explicit `alchemy unsafe nuke`. A
      // normal destroy surfaces the API's typed `PreconditionFailed`.
      if (force && !current.isDeletable) {
        yield* postgres.updateInstanceProtection({
          ...scope,
          instanceId: current.id,
          isDeletable: true,
        });
      }
      const alreadyFailed = current.state === "FAILURE";
      yield* postgres
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
