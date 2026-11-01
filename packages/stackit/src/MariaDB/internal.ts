/**
 * The MariaDB API behind the shared Data Services lifecycle, with its typed tags
 * handled. Not exported from the namespace barrel.
 */
import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";
import {
  updatesConflictRetry,
  type DataServiceApi,
  type DataServiceCredentialApi,
} from "../internal/dataServices.ts";

export type MariaDBError =
  | mariadb.GetInstanceError
  | mariadb.ListInstancesError
  | mariadb.ListOfferingsError
  | mariadb.CreateInstanceError
  | mariadb.PartialUpdateInstanceError
  | mariadb.DeleteInstanceError
  | mariadb.GetUpdatesError
  | mariadb.UpdateUpdatesSettingsError
  | mariadb.UpdateBackupsConfigError
  | mariadb.GetCredentialsError
  | mariadb.CreateCredentialsError
  | mariadb.DeleteCredentialsError;

const onScope = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

export const INSTANCE_LABEL = "STACKIT MariaDB instance";
export const CREDENTIAL_LABEL = "STACKIT MariaDB credential";

export const instanceApi: DataServiceApi<
  MariaDBError,
  mariadb.StackitOpContext,
  mariadb.InstanceParameters
> = {
  getInstance: (scope, instanceId) =>
    mariadb
      .getInstance({ ...onScope(scope), instanceId })
      .pipe(Effect.catchTag(["NotFound", "InstanceGone"], () => Effect.undefined)),
  listInstances: (scope) =>
    mariadb.listInstances(onScope(scope)).pipe(Effect.map((response) => response.instances)),
  listOfferings: (scope) =>
    mariadb.listOfferings(onScope(scope)).pipe(Effect.map((response) => response.offerings)),
  createInstance: (scope, request) =>
    mariadb
      .createInstance({ ...onScope(scope), ...request })
      .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
  updateInstance: (scope, instanceId, request) =>
    mariadb
      .partialUpdateInstance({ ...onScope(scope), instanceId, ...request })
      .pipe(Effect.asVoid),
  deleteInstance: (scope, instanceId) =>
    mariadb.deleteInstance({ ...onScope(scope), instanceId }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
  getAutomaticUpdates: (scope, instanceId) =>
    mariadb.getUpdates({ ...onScope(scope), instanceId }).pipe(
      Effect.retry(updatesConflictRetry),
      Effect.map((response) => response.automaticUpdatesEnabled),
    ),
  setAutomaticUpdates: (scope, instanceId, enabled) =>
    mariadb
      .updateUpdatesSettings({
        ...onScope(scope),
        instanceId,
        automaticUpdatesEnabled: enabled,
      })
      .pipe(Effect.retry(updatesConflictRetry), Effect.asVoid),
  setBackupEncryptionKey: (scope, instanceId, key) =>
    mariadb
      .updateBackupsConfig({ ...onScope(scope), instanceId, encryption_key: key })
      .pipe(Effect.asVoid),
};

export const credentialApi: DataServiceCredentialApi<
  MariaDBError,
  mariadb.StackitOpContext,
  mariadb.CredentialsResponse
> = {
  getCredential: (scope, instanceId, credentialId) =>
    mariadb
      .getCredentials({ ...onScope(scope), instanceId, credentialsId: credentialId })
      .pipe(Effect.catchTag(["NotFound", "CredentialsGone"], () => Effect.undefined)),
  createCredential: (scope, instanceId) =>
    mariadb.createCredentials({ ...onScope(scope), instanceId }),
  deleteCredential: (scope, instanceId, credentialId) =>
    mariadb.deleteCredentials({ ...onScope(scope), instanceId, credentialsId: credentialId }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
};
