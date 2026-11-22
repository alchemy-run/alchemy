import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { CheckRevisions } from "./CheckRevisions.ts";

/**
 * Implementation of {@link CheckRevisions} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.CheckRevisions
 */
export const CheckRevisionsHttp = Layer.effect(
  CheckRevisions,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.CheckRevisions",
    operation: appconfig.CheckRevisions,
    grants: [AppConfigurationRole.KeyValueRead],
  }),
);
