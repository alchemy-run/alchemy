/**
 * Shared scaffolding for the STACKIT RabbitMQ resources. Not exported from the
 * namespace barrel.
 */
import * as rabbitmq from "@distilled.cloud/stackit/rabbitmq";
import * as Effect from "effect/Effect";
import type { ProjectScope } from "../IaaS/internal.ts";
import {
  updatesConflictRetry,
  type DataServiceApi,
  type DataServiceCredentialApi,
} from "../internal/dataServices.ts";

/** What the management API's operations can fail with once their handled tags are gone. */
export type RabbitMQApiError =
  | rabbitmq.BadRequest
  | rabbitmq.NotFound
  | rabbitmq.Conflict
  | rabbitmq.StackitOpError;

/** What the management API's operations need. */
export type RabbitMQApiContext = rabbitmq.StackitOpContext;

/** The API puts the region in the path, as `regionId`. */
const onRegion = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/** The instance operations the shared Data Services lifecycle calls. */
export const instanceApi: DataServiceApi<
  RabbitMQApiError,
  RabbitMQApiContext,
  rabbitmq.InstanceParameters
> = {
  getInstance: (scope, instanceId) =>
    rabbitmq
      .getInstance({ ...onRegion(scope), instanceId })
      .pipe(Effect.catchTag(["NotFound", "InstanceGone"], () => Effect.undefined)),
  listInstances: (scope) =>
    rabbitmq.listInstances(onRegion(scope)).pipe(Effect.map((response) => response.instances)),
  listOfferings: (scope) =>
    rabbitmq.listOfferings(onRegion(scope)).pipe(Effect.map((response) => response.offerings)),
  createInstance: (scope, request) =>
    rabbitmq
      .createInstance({ ...onRegion(scope), ...request })
      .pipe(Effect.catchTag("Conflict", () => Effect.undefined)),
  updateInstance: (scope, instanceId, request) =>
    rabbitmq
      .partialUpdateInstance({ ...onRegion(scope), instanceId, ...request })
      .pipe(Effect.asVoid),
  deleteInstance: (scope, instanceId) =>
    rabbitmq.deleteInstance({ ...onRegion(scope), instanceId }).pipe(
      Effect.asVoid,
      Effect.catchTag("NotFound", () => Effect.void),
    ),
  getAutomaticUpdates: (scope, instanceId) =>
    rabbitmq.getUpdates({ ...onRegion(scope), instanceId }).pipe(
      Effect.retry(updatesConflictRetry),
      Effect.map((response) => response.automaticUpdatesEnabled),
    ),
  setAutomaticUpdates: (scope, instanceId, enabled) =>
    rabbitmq
      .updateUpdatesSettings({
        ...onRegion(scope),
        instanceId,
        automaticUpdatesEnabled: enabled,
      })
      .pipe(Effect.retry(updatesConflictRetry), Effect.asVoid),
  setBackupEncryptionKey: (scope, instanceId, key) =>
    rabbitmq
      .updateBackupsConfig({ ...onRegion(scope), instanceId, encryption_key: key })
      .pipe(Effect.asVoid),
};

/**
 * The credential operations the shared Data Services lifecycle calls. `roles` are
 * the ones a new credential gets, which is all a credential can configure.
 */
export const credentialApi = (
  roles: rabbitmq.CredentialsParametersRolesList | undefined,
): DataServiceCredentialApi<
  RabbitMQApiError,
  RabbitMQApiContext,
  rabbitmq.CredentialsResponse
> => ({
  getCredential: (scope, instanceId, credentialId) =>
    rabbitmq
      .getCredentials({ ...onRegion(scope), instanceId, credentialsId: credentialId })
      .pipe(Effect.catchTag(["NotFound", "CredentialsGone"], () => Effect.undefined)),
  createCredential: (scope, instanceId) =>
    rabbitmq.createCredentials({
      ...onRegion(scope),
      instanceId,
      ...(roles !== undefined ? { parameters: { roles } } : {}),
    }),
  deleteCredential: (scope, instanceId, credentialId) =>
    rabbitmq
      .deleteCredentials({ ...onRegion(scope), instanceId, credentialsId: credentialId })
      .pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
      ),
});

/**
 * The virtual host a credential's AMQP URI points at: its path, or `/` without one.
 * Returns `/` for a URI that doesn't parse, and doesn't quote it: it holds the password.
 */
export const vhostOfUri = (uri: string): string => {
  if (!URL.canParse(uri)) return "/";
  const path = new URL(uri).pathname.replace(/^\//, "");
  if (path === "") return "/";
  try {
    return decodeURIComponent(path);
  } catch {
    // A stray `%`: the broker's name isn't encoded, so it is the path as it stands.
    return path;
  }
};
