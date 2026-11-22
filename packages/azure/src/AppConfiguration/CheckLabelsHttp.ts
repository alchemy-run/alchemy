import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { CheckLabels } from "./CheckLabels.ts";

/**
 * Implementation of {@link CheckLabels} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.CheckLabels
 */
export const CheckLabelsHttp = Layer.effect(
  CheckLabels,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.CheckLabels",
    operation: appconfig.CheckLabels,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
