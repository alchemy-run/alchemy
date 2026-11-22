import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { CheckKeyValues } from "./CheckKeyValues.ts";

/**
 * Implementation of {@link CheckKeyValues} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.CheckKeyValues
 */
export const CheckKeyValuesHttp = Layer.effect(
  CheckKeyValues,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.CheckKeyValues",
    operation: appconfig.CheckKeyValues,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
