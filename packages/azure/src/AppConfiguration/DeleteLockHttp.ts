import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { DeleteLock } from "./DeleteLock.ts";

/**
 * Implementation of {@link DeleteLock} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueWriteRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.DeleteLock
 */
export const DeleteLockHttp = Layer.effect(
  DeleteLock,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.DeleteLock",
    operation: appconfig.DeleteLock,
    grants: [AppConfigurationRole.KeyValueWrite],
  }),
);
