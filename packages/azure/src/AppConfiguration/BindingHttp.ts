import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { ConfigurationStore } from "./ConfigurationStore.ts";
import type {
  ConfigurationSetting,
  ConfigurationSettingFilter,
  ReadConfigurationStoreClient,
} from "./ConfigurationStoreRead.ts";
import type {
  ConfigurationSettingOptions,
  WriteConfigurationStoreClient,
} from "./ConfigurationStoreWrite.ts";

/**
 * Shared scaffolding for the App Configuration data-plane bindings:
 * resolves the distilled `appconfiguration-data` operation once when the
 * layer is built, injects the bound store's endpoint, and assigns the
 * binding's roles on that store at deploy time.
 *
 * NOT exported from `index.ts`.
 */

const STORES = "Microsoft.AppConfiguration/configurationStores";

/** App Configuration data actions (Azure RBAC). */
export const AppConfigurationDataAction = {
  readKeyValues: `${STORES}/keyValues/read`,
  writeKeyValues: `${STORES}/keyValues/write`,
  deleteKeyValues: `${STORES}/keyValues/delete`,
  readSnapshots: `${STORES}/snapshots/read`,
  writeSnapshots: `${STORES}/snapshots/write`,
  archiveSnapshots: `${STORES}/snapshots/archive/action`,
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound store) with
 * exactly `dataActions`. The built-in **App Configuration Data Reader**
 * (`*\/read`) and **Data Owner** (`*\/read`, `*\/write`, `*\/delete`,
 * `*\/action`) also cover snapshots, feature flags, and schemas, so every
 * binding uses a custom role.
 */
export interface AppConfigurationGrant {
  readonly role: string;
  readonly dataActions: readonly string[];
}

const A = AppConfigurationDataAction;

/** Custom role per data action; the logical ID is `AzureAppConfiguration<role>Role`. */
export const AppConfigurationRole = {
  KeyValueRead: { role: "KeyValueRead", dataActions: [A.readKeyValues] },
  KeyValueWrite: { role: "KeyValueWrite", dataActions: [A.writeKeyValues] },
  KeyValueDelete: { role: "KeyValueDelete", dataActions: [A.deleteKeyValues] },
  SnapshotRead: { role: "SnapshotRead", dataActions: [A.readSnapshots] },
  SnapshotWrite: { role: "SnapshotWrite", dataActions: [A.writeSnapshots] },
  SnapshotArchive: { role: "SnapshotArchive", dataActions: [A.archiveSnapshots] },
  ConfigurationStoreWrite: {
    role: "ConfigurationStoreWrite",
    dataActions: [A.writeKeyValues, A.deleteKeyValues],
  },
} as const satisfies Record<string, AppConfigurationGrant>;

/** Assign `grants` on the store to the host, creating the custom roles they name. */
const GrantAppConfigurationRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    store: ConfigurationStore,
    grants: readonly AppConfigurationGrant[],
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        const role = yield* AzureRoleDefinition(`AzureAppConfiguration${grant.role}Role`, {
          description: `Alchemy App Configuration binding: ${grant.dataActions.join(", ")}`,
          permissions: [{ dataActions: [...grant.dataActions] }],
        });
        roleAssignments.push({
          roleDefinitionId: role.roleDefinitionId,
          scope: store.configurationStoreId,
        });
      }
      yield* bind`${tag}(${store})`({ roleAssignments });
    }
  });
});

/** Where a store's data plane lives, resolved per call at runtime. */
export interface StoreAddress {
  readonly tag: string;
  readonly endpoint: Effect.Effect<string>;
}

const storeAddressOf = Effect.fn(function* (tag: string, store: ConfigurationStore) {
  const endpoint = yield* store.endpoint;
  return { tag: `${tag}(${store.LogicalId})`, endpoint } satisfies StoreAddress;
});

/**
 * Build the impl Effect for a store-scoped operation whose request carries
 * the data-plane `endpoint` (every `appconfiguration-data` operation): the
 * runtime callable injects the bound {@link ConfigurationStore}'s endpoint,
 * and the deploy-time half assigns `grants` on the store.
 */
export const makeStoreHttpBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.AppConfiguration.GetKeyValue`. */
  tag: string;
  /** The distilled operation; the store endpoint is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the store. */
  grants: readonly AppConfigurationGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantAppConfigurationRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (store: ConfigurationStore) {
      yield* grant(options.tag, store, options.grants);
      const address = yield* storeAddressOf(options.tag, store);
      return Effect.fn(address.tag)(function* (request?: Omit<I, "endpoint">) {
        const endpoint = yield* address.endpoint;
        return yield* op({ ...request, endpoint } as I);
      });
    });
  });

const toSetting = (kv: appconfig.KeyValue): ConfigurationSetting => ({
  key: kv.key,
  label: kv.label ?? undefined,
  value: kv.value ?? undefined,
  contentType: kv.content_type ?? undefined,
  tags: kv.tags ?? undefined,
  etag: kv.etag,
  lastModified: kv.last_modified,
  locked: kv.locked,
});

export const makeReadConfigurationStoreClient = Effect.gen(function* () {
  const getKeyValue = yield* AzureBindings.withCredentials(appconfig.GetKeyValue);
  const getKeyValues = yield* AzureBindings.withCredentials(appconfig.GetKeyValues);
  return (address: StoreAddress): ReadConfigurationStoreClient => ({
    get: Effect.fn(`${address.tag}.get`)(function* (key: string, options?: { label?: string }) {
      const endpoint = yield* address.endpoint;
      return yield* getKeyValue({ endpoint, key, label: options?.label }).pipe(
        Effect.map(toSetting),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    list: Effect.fn(`${address.tag}.list`)(function* (filter?: ConfigurationSettingFilter) {
      const endpoint = yield* address.endpoint;
      const items = yield* Stream.runCollect(
        getKeyValues.items({
          endpoint,
          key: filter?.key,
          label: filter?.label,
          tags: filter?.tags,
        }),
      );
      return Array.from(items, toSetting);
    }),
  });
});

export const makeWriteConfigurationStoreClient = Effect.gen(function* () {
  const putKeyValue = yield* AzureBindings.withCredentials(appconfig.PutKeyValue);
  const deleteKeyValue = yield* AzureBindings.withCredentials(appconfig.DeleteKeyValue);
  return (address: StoreAddress): WriteConfigurationStoreClient => ({
    set: Effect.fn(`${address.tag}.set`)(function* (
      key: string,
      value: string,
      options?: ConfigurationSettingOptions,
    ) {
      const endpoint = yield* address.endpoint;
      const written = yield* putKeyValue({
        endpoint,
        key,
        label: options?.label,
        value,
        content_type: options?.contentType,
        tags: options?.tags,
      });
      return toSetting(written);
    }),
    delete: Effect.fn(`${address.tag}.delete`)(function* (
      key: string,
      options?: { label?: string },
    ) {
      const endpoint = yield* address.endpoint;
      yield* deleteKeyValue({ endpoint, key, label: options?.label });
    }),
  });
});

/**
 * Build a Read/Write/ReadWrite store binding that assigns `grants` on the
 * store and returns the client `makeClient` builds.
 */
export const makeStoreLevelBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.AppConfiguration.ConfigurationStoreRead`. */
  tag: string;
  /** Roles assigned on the store. */
  grants: readonly AppConfigurationGrant[];
  makeClient: Effect.Effect<(address: StoreAddress) => Client>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantAppConfigurationRoles;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (store: ConfigurationStore) {
      yield* grant(options.tag, store, options.grants);
      const address = yield* storeAddressOf(options.tag, store);
      return makeClient(address);
    });
  });
