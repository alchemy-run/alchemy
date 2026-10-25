import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { CheckSnapshots } from "./CheckSnapshots.ts";

/**
 * Implementation of {@link CheckSnapshots} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationSnapshotReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.CheckSnapshots
 */
export const CheckSnapshotsHttp = Layer.effect(
  CheckSnapshots,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.CheckSnapshots",
    operation: appconfig.CheckSnapshots,
    grants: [AppConfigurationRole.SnapshotRead],
  }),
);
