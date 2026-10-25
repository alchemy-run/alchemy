import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { DeleteKeyValue } from "./DeleteKeyValue.ts";

/**
 * Implementation of {@link DeleteKeyValue} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueDeleteRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.DeleteKeyValue
 */
export const DeleteKeyValueHttp = Layer.effect(
  DeleteKeyValue,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.DeleteKeyValue",
    operation: appconfig.DeleteKeyValue,
    grants: [AppConfigurationRole.KeyValueDelete],
  }),
);
