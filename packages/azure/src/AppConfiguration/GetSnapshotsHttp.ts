import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { GetSnapshots } from "./GetSnapshots.ts";

/**
 * Implementation of {@link GetSnapshots} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationSnapshotReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.GetSnapshots
 */
export const GetSnapshotsHttp = Layer.effect(
  GetSnapshots,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.GetSnapshots",
    operation: appconfig.GetSnapshots,
    grants: [AppConfigurationRole.SnapshotRead],
  }),
);
