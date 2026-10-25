import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { CheckSnapshot } from "./CheckSnapshot.ts";

/**
 * Implementation of {@link CheckSnapshot} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationSnapshotReadRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.CheckSnapshot
 */
export const CheckSnapshotHttp = Layer.effect(
  CheckSnapshot,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.CheckSnapshot",
    operation: appconfig.CheckSnapshot,
    grants: [AppConfigurationRole.SnapshotRead],
  }),
);
