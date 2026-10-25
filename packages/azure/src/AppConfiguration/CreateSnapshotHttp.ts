import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { CreateSnapshot } from "./CreateSnapshot.ts";

/**
 * Implementation of {@link CreateSnapshot} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationSnapshotWriteRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.CreateSnapshot
 */
export const CreateSnapshotHttp = Layer.effect(
  CreateSnapshot,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.CreateSnapshot",
    operation: appconfig.CreateSnapshot,
    grants: [AppConfigurationRole.SnapshotWrite],
  }),
);
