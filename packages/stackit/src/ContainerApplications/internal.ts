import * as sca from "@distilled.cloud/stackit/sca";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { makeKeyedLock } from "../internal/lock.ts";

/**
 * ASSUMPTION for the first live deploy: the id Container Applications is enabled
 * under. The spec names none, and neither STACKIT's docs nor its SDKs show one. It
 * follows `cloud.stackit.functions` and `cloud.stackit.ske`. See
 * {@link ensureContainerApplicationsEnabled}.
 */
export const CONTAINER_APPLICATIONS_SERVICE_ID = "cloud.stackit.sca";

/** Longest generated application name. The spec states no limit, so this is ours. */
export const APPLICATION_NAME_MAX_LENGTH = 63;

/** Longest generated environment name. The spec states no limit, so this is ours. */
export const ENVIRONMENT_NAME_MAX_LENGTH = 63;

/**
 * Port when the props name none: the spec's example for `network.public.port`,
 * and what its example image, `nginxinc/nginx-unprivileged`, listens on.
 */
export const DEFAULT_APPLICATION_PORT = 8080;

/** Budget for an application to run. STACKIT's Go SDK allows 45 minutes for this. */
export const APPLICATION_TIMEOUT = "15 minutes";

/** Budget for a deleted application to disappear. The Go SDK allows 45 minutes. */
export const APPLICATION_DELETE_TIMEOUT = "15 minutes";

/** Budget for a new environment; the API reports no typical time. */
export const ENVIRONMENT_TIMEOUT = "5 minutes";

/** Project, region and environment: the scope of everything but an environment. */
export interface EnvironmentScope {
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
}

/**
 * Try to enable the service for the project. {@link CONTAINER_APPLICATIONS_SERVICE_ID}
 * is an assumption, so a `NotFound`, the answer for an unknown id, is not a failure:
 * the API's own answer then decides whether the project can use the service.
 */
export const ensureContainerApplicationsEnabled = (projectId: string, region: string) =>
  ensureServiceEnabled({
    projectId,
    region,
    serviceId: CONTAINER_APPLICATIONS_SERVICE_ID,
  }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

/**
 * The name of an environment Alchemy names. It has no generation in it, unlike every
 * other generated name: the API can't delete an environment, so a new generation can
 * only ever pick up the one it left behind.
 */
export const generatedEnvironmentName = (id: string) =>
  createPhysicalName({
    id,
    lowercase: true,
    maxLength: ENVIRONMENT_NAME_MAX_LENGTH,
    suffixLength: 0,
    // Only read for the suffix, which is empty.
    instanceId: "00",
  }).pipe(Effect.map((name) => name.replace(/-+$/, "")));

/** Read an environment by id; `undefined` when it is missing. */
export const getEnvironmentOrUndefined = (scope: EnvironmentScope) =>
  sca.getEnvironment(scope).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every environment of a project. The list has no pages. */
export const listAllEnvironments = (projectId: string, region: string) =>
  sca.listEnvironments({ projectId, region }).pipe(Effect.map((listed) => listed.items ?? []));

/** Read an application by id; `undefined` when it is missing. */
export const getApplicationOrUndefined = (scope: EnvironmentScope, applicationId: string) =>
  sca
    .getApplication({ ...scope, applicationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * The application of this name in an environment, or `undefined`. `listApplications` types
 * no answer for a missing environment, so that case is read first, from `getEnvironment`,
 * which does. The list has no pages.
 */
export const findApplicationByName = (scope: EnvironmentScope, displayName: string) =>
  Effect.gen(function* () {
    if ((yield* getEnvironmentOrUndefined(scope)) === undefined) return undefined;
    const { items } = yield* sca.listApplications(scope);
    const summary = (items ?? []).find((item) => item.displayName === displayName);
    return summary?.id === undefined
      ? undefined
      : yield* getApplicationOrUndefined(scope, summary.id);
  });

/** The secrets of an environment; none when the environment is missing. */
export const listSecrets = (scope: EnvironmentScope) =>
  sca.listEnvironmentSecrets(scope).pipe(
    Effect.map((vault) => vault.secrets),
    Effect.catchTag("NotFound", () => Effect.succeed<sca.EnvironmentSecret[]>([])),
  );

/** The registries of an environment; none when the environment is missing. */
export const listRegistries = (scope: EnvironmentScope) =>
  sca.listEnvironmentRegistries(scope).pipe(
    Effect.map((vault) => vault.registries),
    Effect.catchTag("NotFound", () => Effect.succeed<sca.EnvironmentRegistry[]>([])),
  );

const secretLocks = /*@__PURE__*/ makeKeyedLock();
const registryLocks = /*@__PURE__*/ makeKeyedLock();

const lockKey = (scope: EnvironmentScope) =>
  `${scope.projectId}/${scope.region}/${scope.environmentId}`;

/**
 * Serialize a change to an environment's secret collection and its read-back. Every
 * `EnvironmentSecret` and `Application` of an environment shares that one document.
 */
export const withSecretLock = (scope: EnvironmentScope) => secretLocks(lockKey(scope));

/** Serialize a change to an environment's registry collection and its read-back. */
export const withRegistryLock = (scope: EnvironmentScope) => registryLocks(lockKey(scope));

/** How long a change to a collection gets to show up in a list. */
const COLLECTION_POLL = { schedule: Schedule.spaced("3 seconds"), times: 10 } as const;

/**
 * Take keys out of an environment's secrets, and return those still there. The API has
 * no delete, and its spec calls the PATCH body "the subset of secrets to merge or replace
 * in the vault" and doesn't say what removes one. So this sends every other key, with no
 * value, which the spec says keeps it, and checks the result. It changes nothing on an API
 * that only merges, which is why the caller decides what a key left behind means.
 */
export const removeSecretKeys = (scope: EnvironmentScope, keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const observed = yield* listSecrets(scope);
    if (!observed.some((secret) => keys.includes(secret.key))) return [];
    yield* sca
      .updateEnvironmentSecrets({
        ...scope,
        secrets: observed
          .filter((secret) => !keys.includes(secret.key))
          .map((secret) => ({ key: secret.key })),
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    const left = yield* listSecrets(scope).pipe(
      Effect.map((secrets) =>
        secrets.filter((secret) => keys.includes(secret.key)).map((secret) => secret.key),
      ),
      Effect.repeat({ ...COLLECTION_POLL, until: (found) => found.length === 0 }),
    );
    return left;
  }).pipe(withSecretLock(scope));

/** {@link removeSecretKeys} for a registry, by its `server`. */
export const removeRegistry = (scope: EnvironmentScope, server: string) =>
  Effect.gen(function* () {
    const observed = yield* listRegistries(scope);
    if (!observed.some((registry) => registry.server === server)) return false;
    yield* sca
      .updateEnvironmentRegistries({
        ...scope,
        registries: observed
          .filter((registry) => registry.server !== server)
          .map((registry) => ({ server: registry.server })),
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    return yield* listRegistries(scope).pipe(
      Effect.map((registries) => registries.some((registry) => registry.server === server)),
      Effect.repeat({ ...COLLECTION_POLL, until: (left) => !left }),
    );
  }).pipe(withRegistryLock(scope));

/** The API returned an object with no id; the spec marks it optional. */
export class ContainerApplicationsIdMissing extends Data.TaggedError(
  "Stackit.ContainerApplications.IdMissing",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}
