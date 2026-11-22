import * as Layer from "effect/Layer";
import {
  AppConfigurationRole,
  makeReadConfigurationStoreClient,
  makeStoreLevelBinding,
} from "./BindingHttp.ts";
import { ConfigurationStoreRead } from "./ConfigurationStoreRead.ts";

/**
 * Implementation of {@link ConfigurationStoreRead} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.ConfigurationStoreRead
 */
export const ConfigurationStoreReadHttp = Layer.effect(
  ConfigurationStoreRead,
  makeStoreLevelBinding({
    tag: "Azure.AppConfiguration.ConfigurationStoreRead",
    grants: [AppConfigurationRole.KeyValueRead],
    makeClient: makeReadConfigurationStoreClient,
  }),
);
