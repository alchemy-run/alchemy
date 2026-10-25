import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { CheckKeyValue } from "./CheckKeyValue.ts";

/**
 * Implementation of {@link CheckKeyValue} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.CheckKeyValue
 */
export const CheckKeyValueHttp = Layer.effect(
  CheckKeyValue,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.CheckKeyValue",
    operation: appconfig.CheckKeyValue,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
