import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { GetKeyValues } from "./GetKeyValues.ts";

/**
 * Implementation of {@link GetKeyValues} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.GetKeyValues
 */
export const GetKeyValuesHttp = Layer.effect(
  GetKeyValues,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.GetKeyValues",
    operation: appconfig.GetKeyValues,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
