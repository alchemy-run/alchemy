/**
 * The LogMe API behind the lifecycle it shares with OpenSearch, with its typed tags
 * handled. Not exported from the namespace barrel.
 */
import * as logme from "@distilled.cloud/stackit/logme";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";
import {
  updatesConflictRetry,
  type SearchServiceApi,
  type SearchServiceCredentialApi,
} from "../OpenSearch/internal.ts";

export type LogMeError =
  | logme.GetInstanceError
  | logme.ListInstancesError
  | logme.ListOfferingsError
  | logme.CreateInstanceError
  | logme.PartialUpdateInstanceError
  | logme.DeleteInstanceError
  | logme.GetUpdatesError
  | logme.UpdateUpdatesSettingsError
  | logme.UpdateBackupsConfigError
  | logme.GetCredentialsError
  | logme.CreateCredentialsError
  | logme.DeleteCredentialsError;

const onScope = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

export const INSTANCE_LABEL = "STACKIT LogMe instance";
export const CREDENTIAL_LABEL = "STACKIT LogMe credential";

export const instanceApi: SearchServiceApi<
  LogMeError,
  logme.StackitOpContext,
  logme.InstanceParameters
> = {
  getInstance: (scope, instanceId) =>
    logme
      .getInstance({ ...onScope(scope), instanceId })
      .pipe(Effect.catchTag(["NotFound", "InstanceGone"], () => Effect.undefined)),
  listInstances: (scope) =>
    logme.listInstances(onScope(scope)).pipe(Effect.map((response) => response.instances)),
  listOfferings: (scope) =>
    logme.listOfferings(onScope(scope)).pipe(Effect.map((response) => response.offerings)),
  createInstance: (scope, request) =>
    logme
      .createInstance({ ...onScope(scope), ...request })
      .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
  updateInstance: (scope, instanceId, request) =>
    logme.partialUpdateInstance({ ...onScope(scope), instanceId, ...request }).pipe(Effect.asVoid),
  deleteInstance: (scope, instanceId) =>
    logme.deleteInstance({ ...onScope(scope), instanceId }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
  getAutomaticUpdates: (scope, instanceId) =>
    logme.getUpdates({ ...onScope(scope), instanceId }).pipe(
      Effect.retry(updatesConflictRetry),
      Effect.map((response) => response.automaticUpdatesEnabled),
    ),
  setAutomaticUpdates: (scope, instanceId, enabled) =>
    logme
      .updateUpdatesSettings({
        ...onScope(scope),
        instanceId,
        automaticUpdatesEnabled: enabled,
      })
      .pipe(Effect.retry(updatesConflictRetry), Effect.asVoid),
  setBackupEncryptionKey: (scope, instanceId, key) =>
    logme
      .updateBackupsConfig({ ...onScope(scope), instanceId, encryption_key: key })
      .pipe(Effect.asVoid),
};

export const credentialApi: SearchServiceCredentialApi<
  LogMeError,
  logme.StackitOpContext,
  logme.CredentialsResponse
> = {
  getCredential: (scope, instanceId, credentialId) =>
    logme
      .getCredentials({ ...onScope(scope), instanceId, credentialsId: credentialId })
      .pipe(Effect.catchTag(["NotFound", "CredentialsGone"], () => Effect.undefined)),
  createCredential: (scope, instanceId) =>
    logme.createCredentials({ ...onScope(scope), instanceId }),
  deleteCredential: (scope, instanceId, credentialId) =>
    logme.deleteCredentials({ ...onScope(scope), instanceId, credentialsId: credentialId }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
};
