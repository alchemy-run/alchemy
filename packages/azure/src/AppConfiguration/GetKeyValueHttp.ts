import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { GetKeyValue } from "./GetKeyValue.ts";

/**
 * Implementation of {@link GetKeyValue} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.GetKeyValue
 */
export const GetKeyValueHttp = Layer.effect(
  GetKeyValue,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.GetKeyValue",
    operation: appconfig.GetKeyValue,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
