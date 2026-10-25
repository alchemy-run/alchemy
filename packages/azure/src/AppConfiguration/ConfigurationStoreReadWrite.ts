import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { ConfigurationStore } from "./ConfigurationStore.ts";
import type { ReadConfigurationStoreClient } from "./ConfigurationStoreRead.ts";
import type { WriteConfigurationStoreClient } from "./ConfigurationStoreWrite.ts";

/** Read + write client for one App Configuration store. */
export interface ReadWriteConfigurationStoreClient
  extends ReadConfigurationStoreClient, WriteConfigurationStoreClient {}

/**
 * Read, write, and delete the settings of an Azure App Configuration store
 * from any host.
 *
 * Binding assigns the custom roles `AzureAppConfigurationKeyValueReadRole`
 * (`keyValues/read`) and `AzureAppConfigurationConfigurationStoreWriteRole`
 * (`keyValues/write` + `keyValues/delete`) on the store only; together they
 * are exactly the data actions the client calls. Managed-identity hosts get
 * the roles on their identity; any other host gets an Entra service
 * principal (see `AzureBindings`). Provide {@link ConfigurationStoreReadWriteHttp}.
 *
 * ### Reading and Writing Settings
 * **Example:** Write a setting and read it back
 * ```typescript
 * // init
 * const config = yield* Azure.AppConfiguration.ConfigurationStoreReadWrite(store);
 *
 * // runtime
 * yield* config.set("App:Color", "green");
 * const color = yield* config.get("App:Color");
 * ```
 *
 * @binding
 * @category AppConfiguration
 */
export interface ConfigurationStoreReadWrite extends Binding.Service<
  ConfigurationStoreReadWrite,
  "Azure.AppConfiguration.ConfigurationStoreReadWrite",
  (store: ConfigurationStore) => Effect.Effect<ReadWriteConfigurationStoreClient>
> {}

export const ConfigurationStoreReadWrite = Binding.Service<ConfigurationStoreReadWrite>(
  "Azure.AppConfiguration.ConfigurationStoreReadWrite",
);
