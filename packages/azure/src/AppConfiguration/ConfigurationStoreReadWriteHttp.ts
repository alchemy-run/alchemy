import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AppConfigurationRole,
  makeReadConfigurationStoreClient,
  makeStoreLevelBinding,
  makeWriteConfigurationStoreClient,
  type StoreAddress,
} from "./BindingHttp.ts";
import {
  ConfigurationStoreReadWrite,
  type ReadWriteConfigurationStoreClient,
} from "./ConfigurationStoreReadWrite.ts";

/**
 * Implementation of {@link ConfigurationStoreReadWrite} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` and
 * `AzureAppConfigurationConfigurationStoreWriteRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.ConfigurationStoreReadWrite
 */
export const ConfigurationStoreReadWriteHttp = Layer.effect(
  ConfigurationStoreReadWrite,
  makeStoreLevelBinding({
    tag: "Azure.AppConfiguration.ConfigurationStoreReadWrite",
    grants: [AppConfigurationRole.KeyValueRead, AppConfigurationRole.ConfigurationStoreWrite],
    makeClient: Effect.gen(function* () {
      const makeRead = yield* makeReadConfigurationStoreClient;
      const makeWrite = yield* makeWriteConfigurationStoreClient;
      return (address: StoreAddress): ReadWriteConfigurationStoreClient => ({
        ...makeRead(address),
        ...makeWrite(address),
      });
    }),
  }),
);
