import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { PutKeyValue } from "./PutKeyValue.ts";

/**
 * Implementation of {@link PutKeyValue} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueWriteRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.PutKeyValue
 */
export const PutKeyValueHttp = Layer.effect(
  PutKeyValue,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.PutKeyValue",
    operation: appconfig.PutKeyValue,
    grants: [AppConfigurationRole.KeyValueWrite],
  }),
);
