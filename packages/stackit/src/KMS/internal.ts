/**
 * Shared scaffolding for the STACKIT KMS resources. Not exported from the
 * namespace barrel.
 *
 * KMS has no labels, so ownership rests on two things only: the id recorded in
 * state, and a generated physical name, which carries the resource's instance
 * id. An explicit `displayName` proves nothing: the API documents no conflict
 * on create, so a same-named key may be someone else's.
 */
import * as kms from "@distilled.cloud/stackit/kms";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import type { ProjectScope, ProjectScopedProps } from "../IaaS/internal.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";

export type { ProjectScope, ProjectScopedProps };

/** The Go SDK's KMS wait handlers budget 10 minutes for every state change. */
export const KMS_TIMEOUT = "10 minutes";

/** `displayName` accepts up to 64 of `[a-zA-Z0-9_-]`. */
export const KMS_NAME_MAX_LENGTH = 64;

/** The generated `displayName` of a resource's current generation. */
export const generatedKmsName = (id: string) =>
  createPhysicalName({ id, maxLength: KMS_NAME_MAX_LENGTH, lowercase: true });

/** Whether a `displayName` has the shape of a generated one: all `list` may enumerate. */
export const isGeneratedKmsName = (name: string): boolean =>
  isGeneratedPhysicalName(name, KMS_NAME_MAX_LENGTH);

/**
 * Whether a resolved `description` differs from the deployed one. An empty one
 * means no description, which is how `toAttrs` reports it, so comparing it as
 * text would replace the resource on every deploy.
 */
export const kmsDescriptionChanged = (
  news: string | undefined,
  olds: string | undefined,
  output: string | undefined,
): boolean => (news ? news !== output : Boolean(olds));

const ringRequest = (scope: ProjectScope, keyRingId: string) => ({
  projectId: scope.projectId,
  regionId: scope.region,
  keyRingId,
});

/** `GetKeyRing`; `undefined` when the ring is gone (typed `NotFound` or `deleted`). */
export const getKeyRingOrUndefined = (scope: ProjectScope, keyRingId: string) =>
  kms.getKeyRing(ringRequest(scope, keyRingId)).pipe(
    Effect.map((ring) => (ring.state === "deleted" ? undefined : ring)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/**
 * A key whose deletion has been scheduled. The spec has a `deleted` state and a
 * `deletionDate` "set when a key is pending deletion", but doesn't say they go
 * together, so either one counts.
 */
export const isKeyPendingDeletion = (key: kms.Key): boolean =>
  key.state === "deleted" || key.deletionDate !== undefined;

/**
 * `GetKey`; `undefined` when the key is gone. A key pending deletion counts as
 * gone: its material may still exist on STACKIT's side, but Alchemy never
 * restores it or hands it to a new deployment.
 */
export const getKeyOrUndefined = (scope: ProjectScope, keyRingId: string, keyId: string) =>
  kms.getKey({ ...ringRequest(scope, keyRingId), keyId }).pipe(
    Effect.map((key) => (isKeyPendingDeletion(key) ? undefined : key)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** `GetWrappingKey`; `undefined` when the wrapping key is gone (`NotFound` or `deleted`). */
export const getWrappingKeyOrUndefined = (
  scope: ProjectScope,
  keyRingId: string,
  wrappingKeyId: string,
) =>
  kms.getWrappingKey({ ...ringRequest(scope, keyRingId), wrappingKeyId }).pipe(
    Effect.map((wrappingKey) => (wrappingKey.state === "deleted" ? undefined : wrappingKey)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** Every key ring in the scope that isn't deleted. The API has no paging here. */
export const listLiveKeyRings = (scope: ProjectScope) =>
  kms
    .listKeyRings({ projectId: scope.projectId, regionId: scope.region })
    .pipe(Effect.map(({ keyRings }) => keyRings.filter((ring) => ring.state !== "deleted")));

/** Every key of a ring that isn't pending deletion; none when the ring is gone. */
export const listLiveKeys = (scope: ProjectScope, keyRingId: string) =>
  kms.listKeys(ringRequest(scope, keyRingId)).pipe(
    Effect.map(({ keys }) => keys.filter((key) => !isKeyPendingDeletion(key))),
    Effect.catchTag("NotFound", () => Effect.succeed<kms.Key[]>([])),
  );

/** Every wrapping key of a ring that isn't deleted; none when the ring is gone. */
export const listLiveWrappingKeys = (scope: ProjectScope, keyRingId: string) =>
  kms.listWrappingKeys(ringRequest(scope, keyRingId)).pipe(
    Effect.map(({ wrappingKeys }) =>
      wrappingKeys.filter((wrappingKey) => wrappingKey.state !== "deleted"),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed<kms.WrappingKey[]>([])),
  );

/** The key rings `list` may enumerate children of: generated names only. */
export const listGeneratedKeyRings = (scope: ProjectScope) =>
  listLiveKeyRings(scope).pipe(
    Effect.map((rings) => rings.filter((ring) => isGeneratedKmsName(ring.displayName))),
  );

/** The newest version a new crypto call can use, if any. */
export const latestActiveVersion = (versions: ReadonlyArray<kms.Version>): number | undefined =>
  versions.reduce<number | undefined>(
    (latest, version) =>
      version.state === "active" && (latest === undefined || version.number > latest)
        ? version.number
        : latest,
    undefined,
  );
