import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as Layer from "effect/Layer";
import { AppConfigurationRole, makeStoreHttpBinding } from "./BindingHttp.ts";
import { PutLock } from "./PutLock.ts";

/**
 * Implementation of {@link PutLock} over the distilled
 * `appconfiguration-data` data plane. Assigns the custom
 * `AzureAppConfigurationKeyValueWriteRole` on the store.
 *
 * @layer
 * @provides Azure.AppConfiguration.PutLock
 */
export const PutLockHttp = Layer.effect(
  PutLock,
  makeStoreHttpBinding({
    tag: "Azure.AppConfiguration.PutLock",
    operation: appconfig.PutLock,
    grants: [AppConfigurationRole.KeyValueWrite],
  }),
);
