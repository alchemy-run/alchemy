import * as Layer from "effect/Layer";
import {
  AppConfigurationRole,
  makeStoreLevelBinding,
  makeWriteConfigurationStoreClient,
} from "./BindingHttp.ts";
import { ConfigurationStoreWrite } from "./ConfigurationStoreWrite.ts";

/**
 * Implementation of {@link ConfigurationStoreWrite} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationConfigurationStoreWriteRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.ConfigurationStoreWrite
 */
export const ConfigurationStoreWriteHttp = Layer.effect(
  ConfigurationStoreWrite,
  makeStoreLevelBinding({
    tag: "Azure.AppConfiguration.ConfigurationStoreWrite",
    grants: [AppConfigurationRole.ConfigurationStoreWrite],
    makeClient: makeWriteConfigurationStoreClient,
  }),
);
