import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { UpdateSnapshot } from "./UpdateSnapshot.ts";

/**
 * Implementation of {@link UpdateSnapshot} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationSnapshotArchiveRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.UpdateSnapshot
 */
export const UpdateSnapshotHttp = Layer.effect(
  UpdateSnapshot,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.UpdateSnapshot",
    operation: appconfig.UpdateSnapshot,
    grants: [AppConfigurationRole.SnapshotArchive],
  }),
);
