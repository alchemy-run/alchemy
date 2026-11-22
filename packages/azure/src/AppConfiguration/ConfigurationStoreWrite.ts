import type * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";
import type { ConfigurationSetting } from "./ConfigurationStoreRead.ts";

/** Options for a setting written with {@link WriteConfigurationStoreClient.set}. */
export interface ConfigurationSettingOptions {
  /** Label of the setting. Omit for the null label. */
  label?: string;
  /** Content type of the value, e.g. `application/json`. */
  contentType?: string;
  /** Tags of the setting. */
  tags?: Record<string, string>;
}

/** Write client for one App Configuration store. */
export interface WriteConfigurationStoreClient {
  /** Create or replace a setting; returns the written revision. */
  set(
    key: string,
    value: string,
    options?: ConfigurationSettingOptions,
  ): Effect.Effect<ConfigurationSetting, appconfig.PutKeyValueError, RuntimeContext>;
  /** Delete a setting (with that label). Deleting a missing setting succeeds. */
  delete(
    key: string,
    options?: { label?: string },
  ): Effect.Effect<void, appconfig.DeleteKeyValueError, RuntimeContext>;
}

/**
 * Write and delete the settings of an Azure App Configuration store from
 * any host.
 *
 * Binding assigns a custom role
 * (`AzureAppConfigurationConfigurationStoreWriteRole`, one per stack) with
 * exactly the data actions `keyValues/write` and `keyValues/delete`, on the
 * store only. The built-in **App Configuration Data Owner** also writes
 * snapshots, feature flags, and schemas. Managed-identity hosts get the
 * role on their identity; any other host gets an Entra service principal
 * (see `AzureBindings`). Provide {@link ConfigurationStoreWriteHttp}.
 *
 * A setting written here is not tracked by `Azure.AppConfiguration.KeyValue`:
 * its next deploy writes the declared value again only if that value
 * changed.
 *
 * ### Writing Settings
 * **Example:** Set and delete a setting
 * ```typescript
 * // init
 * const config = yield* Azure.AppConfiguration.ConfigurationStoreWrite(store);
 *
 * // runtime
 * yield* config.set("App:Color", "green", { label: "prod" });
 * yield* config.delete("App:Legacy", { label: "prod" });
 * // …provided with Effect.provide(Azure.AppConfiguration.ConfigurationStoreWriteHttp)
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface ConfigurationStoreWrite extends Binding.Service<
  ConfigurationStoreWrite,
  "Azure.AppConfiguration.ConfigurationStoreWrite",
  (store: ConfigurationStore) => Effect.Effect<WriteConfigurationStoreClient>
> {}

export const ConfigurationStoreWrite = Binding.Service<ConfigurationStoreWrite>(
  "Azure.AppConfiguration.ConfigurationStoreWrite",
);
