import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { CheckKeys } from "./CheckKeys.ts";

/**
 * Implementation of {@link CheckKeys} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.CheckKeys
 */
export const CheckKeysHttp = Layer.effect(
  CheckKeys,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.CheckKeys",
    operation: appconfig.CheckKeys,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
