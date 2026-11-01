/**
 * The Key Value Store API behind the shared Data Services lifecycle, with its typed tags
 * handled. Not exported from the namespace barrel.
 */
import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";
import {
  updatesConflictRetry,
  type DataServiceApi,
  type DataServiceCredentialApi,
} from "../internal/dataServices.ts";

export type ValkeyError =
  | valkey.GetInstanceError
  | valkey.ListInstancesError
  | valkey.ListOfferingsError
  | valkey.CreateInstanceError
  | valkey.PartialUpdateInstanceError
  | valkey.DeleteInstanceError
  | valkey.GetUpdatesError
  | valkey.UpdateUpdatesSettingsError
  | valkey.UpdateBackupsConfigError
  | valkey.GetCredentialsError
  | valkey.CreateCredentialsError
  | valkey.DeleteCredentialsError;

const onScope = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

export const INSTANCE_LABEL = "STACKIT Key Value Store instance";
export const CREDENTIAL_LABEL = "STACKIT Key Value Store credential";

export const instanceApi: DataServiceApi<
  ValkeyError,
  valkey.StackitOpContext,
  valkey.InstanceParameters
> = {
  getInstance: (scope, instanceId) =>
    valkey
      .getInstance({ ...onScope(scope), instanceId })
      .pipe(Effect.catchTag(["NotFound", "InstanceGone"], () => Effect.undefined)),
  listInstances: (scope) =>
    valkey.listInstances(onScope(scope)).pipe(Effect.map((response) => response.instances)),
  listOfferings: (scope) =>
    valkey.listOfferings(onScope(scope)).pipe(Effect.map((response) => response.offerings)),
  createInstance: (scope, request) =>
    valkey
      .createInstance({ ...onScope(scope), ...request })
      .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
  updateInstance: (scope, instanceId, request) =>
    valkey.partialUpdateInstance({ ...onScope(scope), instanceId, ...request }).pipe(Effect.asVoid),
  deleteInstance: (scope, instanceId) =>
    valkey.deleteInstance({ ...onScope(scope), instanceId }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
  getAutomaticUpdates: (scope, instanceId) =>
    valkey.getUpdates({ ...onScope(scope), instanceId }).pipe(
      Effect.retry(updatesConflictRetry),
      Effect.map((response) => response.automaticUpdatesEnabled),
    ),
  setAutomaticUpdates: (scope, instanceId, enabled) =>
    valkey
      .updateUpdatesSettings({
        ...onScope(scope),
        instanceId,
        automaticUpdatesEnabled: enabled,
      })
      .pipe(Effect.retry(updatesConflictRetry), Effect.asVoid),
  setBackupEncryptionKey: (scope, instanceId, key) =>
    valkey
      .updateBackupsConfig({ ...onScope(scope), instanceId, encryption_key: key })
      .pipe(Effect.asVoid),
};

export const credentialApi: DataServiceCredentialApi<
  ValkeyError,
  valkey.StackitOpContext,
  valkey.CredentialsResponse
> = {
  getCredential: (scope, instanceId, credentialId) =>
    valkey
      .getCredentials({ ...onScope(scope), instanceId, credentialsId: credentialId })
      .pipe(Effect.catchTag(["NotFound", "CredentialsGone"], () => Effect.undefined)),
  createCredential: (scope, instanceId) =>
    valkey.createCredentials({ ...onScope(scope), instanceId }),
  deleteCredential: (scope, instanceId, credentialId) =>
    valkey.deleteCredentials({ ...onScope(scope), instanceId, credentialsId: credentialId }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
};
