import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { GetRevisions } from "./GetRevisions.ts";

/**
 * Implementation of {@link GetRevisions} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.GetRevisions
 */
export const GetRevisionsHttp = Layer.effect(
  GetRevisions,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.GetRevisions",
    operation: appconfig.GetRevisions,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
