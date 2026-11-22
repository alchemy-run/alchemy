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
import type { WireKeyValue, WireKeyValueConnectionInfo } from "./internal/WireTypes.ts";
import type { Providers } from "./Providers.ts";
import type {
  CidrBlockAndDescription,
  DatabaseStatus,
  KeyValuePlan,
  LogStreamOverrideAttributes,
  LogStreamOverrideInput,
  MaxmemoryPolicy,
  PersistenceMode,
  Region,
} from "./Types.ts";

export interface KeyValueConnectionInfo {
  /** External `rediss://` or `redis://` connection URL (redacted). */
  externalConnectionString: Redacted.Redacted<string>;
  /** Internal private network URL for services within Render (redacted). */
  internalConnectionString: Redacted.Redacted<string>;
  /** Ready-to-run `redis-cli` or `valkey-cli` command (redacted). */
  cliCommand: Redacted.Redacted<string>;
}

export interface KeyValueProps {
  /** Key Value instance name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Optional Render project environment ID (`env-...`). */
  environmentId?: string;
  /** Plan slug (`"free"`, `"starter"`, `"standard"`, `"pro"`, `"pro_plus"`, or custom). */
  plan?: KeyValuePlan;
  /** Deployment region (`oregon`, `ohio`, `virginia`, `frankfurt`, `singapore`). Changing it replaces the instance. */
  region?: Region;
  /** Eviction policy when maxmemory is reached (for example `"allkeys_lru"`). */
  maxmemoryPolicy?: MaxmemoryPolicy;
  /** Persistence mode (`"journal_snapshot"`, `"snapshot"`, or `"off"`). Free plans do not support persistence. */
  persistenceMode?: PersistenceMode;
  /** IPv4 CIDR blocks permitted to connect externally. */
  ipAllowList?: CidrBlockAndDescription[];
  /** Optional log stream override scoped to this instance. */
  logStreamOverride?: LogStreamOverrideInput;
}

export interface KeyValueAttributes {
  /** Render Key Value instance ID (`red-...`). */
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
  connectionInfo: KeyValueConnectionInfo;
  /** Log stream override active on this instance, if any. */
  logStreamOverride?: LogStreamOverrideAttributes;
  /** Render Dashboard URL, if returned. */
  dashboardUrl?: string;
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface KeyValueLookup {
  /** Look up an existing Key Value instance by ID (`red-...`). */
  id?: string;
  /** Look up an existing Key Value instance by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

export type KeyValue = Resource<
  "Render.KeyValue",
  KeyValueProps,
  KeyValueAttributes,
  never,
  Providers,
  KeyValueLookup
>;

/**
 * A Render managed Key Value (Redis/Valkey-compatible) datastore with private
 * networking, persistence options, eviction policies, and IP allow listing.
 *
 * Bind with {@link ReadKeyValue}, {@link WriteKeyValue}, or {@link ReadWriteKeyValue}.
 *
 * **Example:** Key Value instance with LRU eviction
 * ```typescript
 * const cache = yield* Render.KeyValue("Cache", {
 *   name: "app-cache",
 *   plan: "starter",
 *   region: "oregon",
 *   maxmemoryPolicy: "allkeys_lru",
 *   persistenceMode: "off",
 * });
 * ```
 *
 * @resource
 * @product Key Value
 * @category Storage & Databases
 */
export const KeyValue = Resource<KeyValue>("Render.KeyValue");

const waitForKeyValueAvailable = (instance: WireKeyValue) =>
  instance.status !== "creating"
    ? Effect.succeed(instance)
    : pollUntil({
        operation: "key-value provisioning",
        resourceId: instance.id,
        check: Client.getKeyValue(instance.id),
        statusOf: (kv) => kv.status,
        failIf: (kv) =>
          kv.status === "unavailable"
            ? new RenderDeployFailedError({
                resourceType: "Render.KeyValue",
                resourceId: instance.id,
                status: kv.status,
                message: `Render KeyValue ${instance.id} entered status "${kv.status}"`,
              })
            : undefined,
        isDone: (kv) => kv.status !== "creating",
      });

const hydrateKeyValue = (kv: WireKeyValue) =>
  Effect.gen(function* () {
    const connInfo: WireKeyValueConnectionInfo = yield* Client.getKeyValueConnectionInfo(kv.id);
    const logStream = yield* Client.ignoreNotFound(Client.getResourceLogStream(kv.id));
    return {
      id: kv.id,
      name: kv.name,
      ownerId: kv.owner.id,
      environmentId: kv.environmentId,
      plan: kv.plan,
      region: kv.region,
      version: kv.version,
      status: kv.status,
      maxmemoryPolicy: kv.options?.maxmemoryPolicy,
      persistenceMode: kv.options?.persistenceMode,
      ipAllowList: kv.ipAllowList ?? [],
      connectionInfo: {
        externalConnectionString: toRedacted(connInfo.externalConnectionString),
        internalConnectionString: toRedacted(connInfo.internalConnectionString),
        cliCommand: toRedacted(connInfo.cliCommand),
      },
      logStreamOverride: logStream?.setting
        ? {
            resourceId: logStream.resourceId ?? kv.id,
            setting: logStream.setting,
            endpoint: logStream.endpoint,
          }
        : undefined,
      dashboardUrl: kv.dashboardUrl,
      createdAt: kv.createdAt,
      updatedAt: kv.updatedAt,
    } satisfies KeyValueAttributes;
  });

export const KeyValueProvider = () =>
  Provider.effect(
    KeyValue,
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
          const kv = yield* Client.ignoreNotFound(Client.getKeyValue(output.id));
          return kv ? yield* hydrateKeyValue(kv) : undefined;
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Client.resolveOwnerId(explicitOwnerId);
        const all = yield* Client.listKeyValue({ ownerId: [ownerId], name: [desiredName] });
        const matched = all.find((k) => k.name === desiredName);
        if (!matched) return undefined;
        const attrs = yield* hydrateKeyValue(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const kv = yield* Client.ignoreNotFound(Client.getKeyValue(props.id));
          return kv ? yield* hydrateKeyValue(kv) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Client.resolveOwnerId(props.ownerId);
          const all = yield* Client.listKeyValue({ ownerId: [ownerId], name: [props.name] });
          const matched = all.find((k) => k.name === props.name);
          return matched ? yield* hydrateKeyValue(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Client.resolveOwnerId();
        const all = yield* Client.listKeyValue({ ownerId: [ownerId] });
        return yield* Effect.forEach(all, hydrateKeyValue);
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output }) {
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Client.ignoreNotFound(Client.getKeyValue(output.id))
          : undefined;

        if (!existing) {
          const ownerId = yield* Client.resolveOwnerId(news.ownerId);
          const created = yield* Client.createKeyValue({
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
          const ready = yield* waitForKeyValueAvailable(created);
          if (news.logStreamOverride) {
            yield* syncResourceLogStream(ready.id, undefined, news.logStreamOverride);
          }
          return yield* hydrateKeyValue(ready);
        }

        const ipAllowList = buildIpAllowListField(news.ipAllowList, olds?.ipAllowList);
        const updated = yield* Client.updateKeyValue(existing.id, {
          name: desiredName,
          ...(news.plan !== undefined ? { plan: news.plan } : {}),
          ...(news.maxmemoryPolicy !== undefined ? { maxmemoryPolicy: news.maxmemoryPolicy } : {}),
          ...(news.persistenceMode !== undefined ? { persistenceMode: news.persistenceMode } : {}),
          ...(ipAllowList !== undefined ? { ipAllowList } : {}),
        });
        const ready = yield* waitForKeyValueAvailable(updated);
        yield* Client.syncResourceEnvironment(
          ready.id,
          ready.environmentId ?? existing.environmentId,
          news.environmentId,
        );
        const currentLog = yield* Client.ignoreNotFound(Client.getResourceLogStream(ready.id));
        yield* syncResourceLogStream(ready.id, currentLog, news.logStreamOverride);
        const refreshed = yield* Client.getKeyValue(ready.id);
        return yield* hydrateKeyValue(refreshed);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Client.deleteKeyValue(output.id);
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
