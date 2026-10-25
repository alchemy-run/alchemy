import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { GetOperationDetails } from "./GetOperationDetails.ts";

/**
 * Implementation of {@link GetOperationDetails} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationSnapshotReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.GetOperationDetails
 */
export const GetOperationDetailsHttp = Layer.effect(
  GetOperationDetails,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.GetOperationDetails",
    operation: appconfig.GetOperationDetails,
    grants: [AppConfigurationRole.SnapshotRead],
  }),
);
