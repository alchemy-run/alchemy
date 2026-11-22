import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { GetLabels } from "./GetLabels.ts";

/**
 * Implementation of {@link GetLabels} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.GetLabels
 */
export const GetLabelsHttp = Layer.effect(
  GetLabels,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.GetLabels",
    operation: appconfig.GetLabels,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
