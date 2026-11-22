import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { RenderDeployFailedError } from "./Errors.ts";
import * as Client from "./internal/Client.ts";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import { pollUntil } from "./internal/Poll.ts";
import { toRedacted } from "./internal/Redacted.ts";
import { buildIpAllowListField, syncResourceLogStream } from "./internal/ServiceBase.ts";
import type { WireRedis, WireRedisConnectionInfo } from "./internal/WireTypes.ts";
import type { Providers } from "./Providers.ts";
import type {
  CidrBlockAndDescription,
  DatabaseStatus,
  LogStreamOverrideAttributes,
  LogStreamOverrideInput,
  MaxmemoryPolicy,
  PersistenceMode,
  RedisPlan,
  Region,
} from "./Types.ts";

export interface RedisConnectionInfo {
  /** External Redis connection URL (redacted). */
  externalConnectionString: Redacted.Redacted<string>;
  /** Internal private network Redis URL (redacted). */
  internalConnectionString: Redacted.Redacted<string>;
  /** Ready-to-run `redis-cli` command (redacted). */
  redisCLICommand: Redacted.Redacted<string>;
}

export interface RedisProps {
  /** Redis instance name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Optional Render project environment ID (`env-...`). */
  environmentId?: string;
  /** Plan slug (`"free"`, `"starter"`, `"standard"`, `"pro"`, `"pro_plus"`, or custom). */
  plan?: RedisPlan;
  /** Deployment region (`oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`). Changing it replaces the instance. */
  region?: Region;
  /** Eviction policy when maxmemory is reached. */
  maxmemoryPolicy?: MaxmemoryPolicy;
  /** Persistence mode (`"journal_snapshot"`, `"snapshot"`, or `"off"`). */
  persistenceMode?: PersistenceMode;
  /** IPv4 CIDR blocks permitted to connect externally. */
  ipAllowList?: CidrBlockAndDescription[];
  /** Optional log stream override scoped to this instance. */
  logStreamOverride?: LogStreamOverrideInput;
}

export interface RedisAttributes {
  /** Render Redis instance ID (`red-...`). */
  id: string;
  /** Instance name. */
  name: string;
  /** Owner workspace ID. */
  ownerId: string;
  /** Associated Render environment ID, if any. */
  environmentId?: string;
  /** Active plan slug. */
  plan: string;
  /** Deployment region. */
  region: string;
  /** Engine version string. */
  version: string;
  /** Lifecycle status. */
  status: DatabaseStatus;
  /** Eviction policy currently configured. */
  maxmemoryPolicy?: string;
  /** Persistence mode currently configured. */
  persistenceMode?: string;
  /** IP allow list rules. */
  ipAllowList: CidrBlockAndDescription[];
  /** Connection credentials & CLI command (redacted). */
  connectionInfo: RedisConnectionInfo;
  /** Log stream override active on this instance, if any. */
  logStreamOverride?: LogStreamOverrideAttributes;
  /** Render Dashboard URL, if returned. */
  dashboardUrl?: string;
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface RedisLookup {
  /** Look up an existing Redis instance by ID (`red-...`). */
  id?: string;
  /** Look up an existing Redis instance by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

export type Redis = Resource<
  "Render.Redis",
  RedisProps,
  RedisAttributes,
  never,
  Providers,
  RedisLookup
>;

/**
 * Legacy Render Redis resource backed by `/v1/redis`. For new workloads,
 * Render recommends {@link KeyValue}; both resources support Alchemy's Redis
 * read/write bindings ({@link ReadWriteKeyValue}).
 *
 * **Example:** Managed Redis instance
 * ```typescript
 * const redis = yield* Render.Redis("LegacyCache", {
 *   name: "legacy-cache",
 *   plan: "free",
 *   region: "oregon",
 *   maxmemoryPolicy: "allkeys_lru",
 * });
 * ```
 *
 * @resource
 * @product Redis
 * @category Storage & Databases
 */
export const Redis = Resource<Redis>("Render.Redis");

const waitForRedisAvailable = (instance: WireRedis) =>
  instance.status !== "creating"
    ? Effect.succeed(instance)
    : pollUntil({
        operation: "redis provisioning",
        resourceId: instance.id,
        check: Client.getRedis(instance.id),
        statusOf: (r) => r.status,
        failIf: (r) =>
          r.status === "unavailable"
            ? new RenderDeployFailedError({
                resourceType: "Render.Redis",
                resourceId: instance.id,
                status: r.status,
                message: `Render Redis ${instance.id} entered status "${r.status}"`,
              })
            : undefined,
        isDone: (r) => r.status !== "creating",
      });

const hydrateRedis = (r: WireRedis) =>
  Effect.gen(function* () {
    const connInfo: WireRedisConnectionInfo = yield* Client.getRedisConnectionInfo(r.id);
    const logStream = yield* Client.ignoreNotFound(Client.getResourceLogStream(r.id));
    return {
      id: r.id,
      name: r.name,
      ownerId: r.owner.id,
      environmentId: r.environmentId,
      plan: r.plan,
      region: r.region,
      version: r.version,
      status: r.status,
      maxmemoryPolicy: r.options?.maxmemoryPolicy,
      persistenceMode: r.options?.persistenceMode,
      ipAllowList: r.ipAllowList ?? [],
      connectionInfo: {
        externalConnectionString: toRedacted(connInfo.externalConnectionString),
        internalConnectionString: toRedacted(connInfo.internalConnectionString),
        redisCLICommand: toRedacted(connInfo.redisCLICommand),
      },
      logStreamOverride: logStream?.setting
        ? {
            resourceId: logStream.resourceId ?? r.id,
            setting: logStream.setting,
            endpoint: logStream.endpoint,
          }
        : undefined,
      dashboardUrl: r.dashboardUrl,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    } satisfies RedisAttributes;
  });

export const RedisProvider = () =>
  Provider.effect(
    Redis,
    Effect.succeed({
      stables: ["id", "region"],
      nuke: {
        dependsOn: ["Render.Environment", "Render.Project"],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        const targetRegion = news.region ?? olds.region;
        const prevRegion = olds.region ?? output?.region;
        if (targetRegion !== undefined && prevRegion !== undefined && targetRegion !== prevRegion) {
          const deleteFirst =
            typeof news.name === "string" && news.name === (output?.name ?? olds.name);
          return { action: "replace", deleteFirst } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        if (output?.id) {
          const r = yield* Client.ignoreNotFound(Client.getRedis(output.id));
          return r ? yield* hydrateRedis(r) : undefined;
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Client.resolveOwnerId(explicitOwnerId);
        const all = yield* Client.listRedis({ ownerId: [ownerId], name: [desiredName] });
        const matched = all.find((k) => k.name === desiredName);
        if (!matched) return undefined;
        const attrs = yield* hydrateRedis(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const r = yield* Client.ignoreNotFound(Client.getRedis(props.id));
          return r ? yield* hydrateRedis(r) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Client.resolveOwnerId(props.ownerId);
          const all = yield* Client.listRedis({ ownerId: [ownerId], name: [props.name] });
          const matched = all.find((k) => k.name === props.name);
          return matched ? yield* hydrateRedis(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Client.resolveOwnerId();
        const all = yield* Client.listRedis({ ownerId: [ownerId] });
        return yield* Effect.forEach(all, hydrateRedis);
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Client.ignoreNotFound(Client.getRedis(output.id))
          : undefined;

        if (!existing) {
          const ownerId = yield* Client.resolveOwnerId(news.ownerId);
          const created = yield* Client.createRedis({
            name: desiredName,
            ownerId,
            plan: news.plan ?? "free",
            ...(news.region !== undefined ? { region: news.region } : {}),
            ...(news.environmentId !== undefined ? { environmentId: news.environmentId } : {}),
            ...(news.maxmemoryPolicy !== undefined
              ? { maxmemoryPolicy: news.maxmemoryPolicy }
              : {}),
            ...(news.persistenceMode !== undefined
              ? { persistenceMode: news.persistenceMode }
              : {}),
            ...(news.ipAllowList !== undefined ? { ipAllowList: news.ipAllowList } : {}),
          });
          const ready = yield* waitForRedisAvailable(created);
          if (news.logStreamOverride) {
            yield* syncResourceLogStream(ready.id, undefined, news.logStreamOverride);
          }
          return yield* hydrateRedis(ready);
        }

        const ipAllowList = buildIpAllowListField(news.ipAllowList, olds?.ipAllowList);
        const updated = yield* Client.updateRedis(existing.id, {
          name: desiredName,
          ...(news.plan !== undefined ? { plan: news.plan } : {}),
          ...(news.maxmemoryPolicy !== undefined ? { maxmemoryPolicy: news.maxmemoryPolicy } : {}),
          ...(news.persistenceMode !== undefined ? { persistenceMode: news.persistenceMode } : {}),
          ...(ipAllowList !== undefined ? { ipAllowList } : {}),
        });
        const ready = yield* waitForRedisAvailable(updated);
        yield* Client.syncResourceEnvironment(
          ready.id,
          ready.environmentId ?? existing.environmentId,
          news.environmentId,
        );
        const currentLog = yield* Client.ignoreNotFound(Client.getResourceLogStream(ready.id));
        yield* syncResourceLogStream(ready.id, currentLog, news.logStreamOverride);
        const refreshed = yield* Client.getRedis(ready.id);
        return yield* hydrateRedis(refreshed);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Client.deleteRedis(output.id);
      }),
      logs: Effect.fn(function* ({ output, options }) {
        return yield* renderResourceLogs({
          ownerId: output.ownerId,
          resourceId: output.id,
          options,
        });
      }),
      tail: ({ output }) =>
        renderResourceTail({
          ownerId: output.ownerId,
          resourceId: output.id,
        }),
    }),
  );
