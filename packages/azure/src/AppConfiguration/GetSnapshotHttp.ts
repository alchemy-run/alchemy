import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { GetSnapshot } from "./GetSnapshot.ts";

/**
 * Implementation of {@link GetSnapshot} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationSnapshotReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.GetSnapshot
 */
export const GetSnapshotHttp = Layer.effect(
  GetSnapshot,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.GetSnapshot",
    operation: appconfig.GetSnapshot,
    grants: [AppConfigurationRole.SnapshotRead],
  }),
);
