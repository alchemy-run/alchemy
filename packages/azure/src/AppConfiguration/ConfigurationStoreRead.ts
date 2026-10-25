import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";

/** One key-value (setting) of an App Configuration store. */
export interface ConfigurationSetting {
  /** Key of the setting. */
  key: string;
  /** Label of the setting (undefined for the null label). */
  label: string | undefined;
  /** Value of the setting. */
  value: string | undefined;
  /** Content type of the value, e.g. `application/json`. */
  contentType: string | undefined;
  /** Tags of the setting. */
  tags: Record<string, string | undefined> | undefined;
  /** ETag of the current revision. */
  etag: string | undefined;
  /** Time of the last change (ISO 8601). */
  lastModified: string | undefined;
  /** Whether the setting is locked (read-only). */
  locked: boolean | undefined;
}

/** Filter for {@link ReadConfigurationStoreClient.list}. */
export interface ConfigurationSettingFilter {
  /**
   * Key filter: an exact key, a prefix ending in `*` (`App:*`), or a
   * comma-separated list. See https://aka.ms/azconfig/docs/keyvaluefiltering.
   */
  key?: string;
  /** Label filter, same syntax as `key`. `\0` matches the null label. */
  label?: string;
  /** Tag filters, each `name=value`. */
  tags?: string[];
}

/** Read client for one App Configuration store. */
export interface ReadConfigurationStoreClient {
  /** Read one setting; `undefined` when the key (with that label) does not exist. */
  get(
    key: string,
    options?: { label?: string },
  ): Effect.Effect<ConfigurationSetting | undefined, appconfig.GetKeyValueError, RuntimeContext>;
  /** List the settings that match `filter` (every page). */
  list(
    filter?: ConfigurationSettingFilter,
  ): Effect.Effect<ConfigurationSetting[], appconfig.GetKeyValuesError, RuntimeContext>;
}

/**
 * Read the settings of an Azure App Configuration store from any host.
 *
 * Binding assigns a custom role (`AzureAppConfigurationKeyValueReadRole`,
 * one per stack) with exactly the data action `keyValues/read`, on the
 * store only. The built-in **App Configuration Data Reader** also reads
 * snapshots, feature flags, and schemas. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity. On any other host (a Cloudflare Worker, an AWS Lambda)
 * Alchemy creates an Entra service principal for the host, assigns the
 * role to it, and binds its client secret into the host's env (see
 * `AzureBindings`). Provide {@link ConfigurationStoreReadHttp}.
 *
 * ### Reading Settings
 * **Example:** Read one setting
 * ```typescript
 * // init
 * const config = yield* Azure.AppConfiguration.ConfigurationStoreRead(store);
 *
 * // runtime
 * const color = yield* config.get("App:Color", { label: "prod" });
 * ```
 *
 * **Example:** List settings by prefix
 * ```typescript
 * const settings = yield* config.list({ key: "App:*", label: "prod" });
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface ConfigurationStoreRead extends Binding.Service<
  ConfigurationStoreRead,
  "Azure.AppConfiguration.ConfigurationStoreRead",
  (store: ConfigurationStore) => Effect.Effect<ReadConfigurationStoreClient>
> {}

export const ConfigurationStoreRead = Binding.Service<ConfigurationStoreRead>(
  "Azure.AppConfiguration.ConfigurationStoreRead",
);
