import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_LOCATION = "us-central1";
const DEFAULT_PURPOSE: kms.CryptoKeyPurposeEnum = "ENCRYPT_DECRYPT";
const DEFAULT_ALGORITHM: kms.CryptoKeyVersionTemplateAlgorithmEnum =
  "GOOGLE_SYMMETRIC_ENCRYPTION";
const DEFAULT_PROTECTION: kms.CryptoKeyVersionTemplateProtectionLevelEnum =
  "SOFTWARE";
const MAX_NAME_LENGTH = 63;
const DELETABLE_VERSION_STATES = new Set([
  "DESTROYED",
  "IMPORT_FAILED",
  "GENERATION_FAILED",
]);
const DESTROYABLE_VERSION_STATES = new Set(["ENABLED", "DISABLED"]);

export type CryptoKeyVersionTemplate = {
  /**
   * Algorithm for new versions. Defaults to `GOOGLE_SYMMETRIC_ENCRYPTION`
   * when `purpose` is `ENCRYPT_DECRYPT`.
   */
  algorithm?: kms.CryptoKeyVersionTemplateAlgorithmEnum | (string & {});
  /**
   * Protection level for new versions. Immutable — changing it replaces
   * the key.
   * @default "SOFTWARE"
   */
  protectionLevel?:
    | kms.CryptoKeyVersionTemplateProtectionLevelEnum
    | (string & {});
};

export type CryptoKeyProps = {
  /**
   * Parent KeyRing. Full name
   * `projects/{project}/locations/{location}/keyRings/{keyRing}` or the
   * key ring id (combined with `location`). Immutable — changing it
   * replaces the key.
   */
  keyRing: string;
  /**
   * Cloud KMS location (`us-central1`, `global`, `us`, …). Used when
   * `keyRing` is a bare id. Immutable — changing it replaces the key.
   * `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * CryptoKey id (the last path segment). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Must match
   * `[a-zA-Z0-9_-]{1,63}`. Immutable — changing it replaces the key.
   * Deleted ids cannot be reused in the same project.
   */
  cryptoKeyId?: string;
  /**
   * Immutable purpose of this key.
   * @default "ENCRYPT_DECRYPT"
   */
  purpose?: kms.CryptoKeyPurposeEnum;
  /**
   * Template for new CryptoKeyVersions. `protectionLevel` is immutable
   * (replacement); `algorithm` can be patched.
   */
  versionTemplate?: CryptoKeyVersionTemplate;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Automatic rotation period (e.g. `"2592000s"`). ENCRYPT_DECRYPT keys
   * only. Must be paired with `nextRotationTime` (Alchemy fills
   * `now + period` when omitted).
   */
  rotationPeriod?: string;
  /**
   * RFC3339 time of the next automatic rotation. ENCRYPT_DECRYPT keys
   * only.
   */
  nextRotationTime?: string;
  /**
   * How long versions stay in `DESTROY_SCHEDULED` before `DESTROYED`.
   * Immutable. Minimum 24h except import-only keys.
   */
  destroyScheduledDuration?: string;
  /**
   * Create the key with no versions so it can be deleted immediately.
   * Create-only — ignored on update.
   * @default false
   */
  skipInitialVersionCreation?: boolean;
  /**
   * Whether this key may contain imported versions only. Immutable.
   * @default false
   */
  importOnly?: boolean;
  /**
   * Backend for EXTERNAL_VPC / HSM_SINGLE_TENANT keys. Immutable.
   */
  cryptoKeyBackend?: string;
};

export type CryptoKeyAttrs = {
  /** Full resource name `projects/.../cryptoKeys/{cryptoKey}`. */
  name: string;
  /** CryptoKey id (last path segment). */
  cryptoKeyId: string;
  /** Parent KeyRing resource name. */
  keyRing: string;
  /** Location id (`us-central1`, `global`, …). */
  location: string;
  /** Project id. */
  project: string;
  /** Key purpose. */
  purpose: string;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** Version template currently applied. */
  versionTemplate: CryptoKeyVersionTemplate | undefined;
  /** Automatic rotation period, if set. */
  rotationPeriod: string | undefined;
  /** Next automatic rotation time, if set. */
  nextRotationTime: string | undefined;
  /** Scheduled-destruction duration. */
  destroyScheduledDuration: string | undefined;
  /** Whether the key is import-only. */
  importOnly: boolean;
  /** External / single-tenant HSM backend, if any. */
  cryptoKeyBackend: string | undefined;
  /** Primary version resource name, if any. */
  primaryVersion: string | undefined;
  /** RFC3339 creation timestamp. */
  createTime: string | undefined;
};

export type CryptoKey = Resource<
  "GCP.KMS.CryptoKey",
  CryptoKeyProps,
  CryptoKeyAttrs,
  never,
  Providers
>;

/**
 * A Cloud KMS CryptoKey — a named key that holds zero or more versions.
 *
 * Purpose, location, parent KeyRing, import-only, backend,
 * `destroyScheduledDuration`, and `versionTemplate.protectionLevel` are
 * immutable (changing them replaces the key). Labels, rotation, and
 * `versionTemplate.algorithm` update in place.
 *
 * Cloud KMS only permanently deletes a CryptoKey after every version is
 * gone. Versions must first be scheduled for destruction (minimum 24h)
 * and then deleted. Keys created with `skipInitialVersionCreation: true`
 * have no versions and can be deleted immediately. Deleted CryptoKey
 * names cannot be reused.
 *
 * ### Creating a CryptoKey
 * **Example:** Generated name on an existing KeyRing
 * ```typescript
 * const ring = yield* GCP.KMS.KeyRing("Keys", {});
 * const key = yield* GCP.KMS.CryptoKey("Data", {
 *   keyRing: ring.name,
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and no initial version
 * ```typescript
 * const key = yield* GCP.KMS.CryptoKey("Data", {
 *   keyRing: ring.name,
 *   cryptoKeyId: "app-data",
 *   labels: { env: "prod" },
 *   skipInitialVersionCreation: true,
 * });
 * ```
 *
 * ### Encrypting and Decrypting
 * **Example:** Encrypt then decrypt
 * ```typescript
 * const encrypt = yield* GCP.KMS.Encrypt(key);
 * const decrypt = yield* GCP.KMS.Decrypt(key);
 * const { ciphertext } = yield* encrypt({
 *   body: { plaintext: btoa("hello") },
 * });
 * const { plaintext } = yield* decrypt({
 *   body: { ciphertext },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category KMS
 */
export const CryptoKey = Resource<CryptoKey>("GCP.KMS.CryptoKey");

export class CryptoKeyNotResolved extends Data.TaggedError(
  "GCP.KMS.CryptoKeyNotResolved",
)<{
  name: string;
}> {}

export class CryptoKeyOperationFailed extends Data.TaggedError(
  "GCP.KMS.CryptoKeyOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class CryptoKeyOperationPending extends Data.TaggedError(
  "GCP.KMS.CryptoKeyOperationPending",
)<{
  operation: string;
}> {}

export class CryptoKeyVersionPending extends Data.TaggedError(
  "GCP.KMS.CryptoKeyVersionPending",
)<{
  name: string;
  state: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const normalizeProtection = (
  value: string | undefined,
): kms.CryptoKeyVersionTemplateProtectionLevelEnum =>
  !value || value === "PROTECTION_LEVEL_UNSPECIFIED"
    ? DEFAULT_PROTECTION
    : (value as kms.CryptoKeyVersionTemplateProtectionLevelEnum);

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const cryptoKeysAt = parts.lastIndexOf("cryptoKeys");
  const keyRingsAt = parts.lastIndexOf("keyRings");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  const keyRing =
    keyRingsAt >= 0 ? parts.slice(0, keyRingsAt + 2).join("/") : "";
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    keyRing,
    cryptoKeyId:
      cryptoKeysAt >= 0 && parts[cryptoKeysAt + 1]
        ? parts[cryptoKeysAt + 1]!
        : lastSegment(name),
  };
};

const resolveParent = (
  project: string,
  keyRing: string,
  location: string | undefined,
) => {
  if (keyRing.includes("/")) {
    const parsed = parseName(
      keyRing.includes("/cryptoKeys/") ? keyRing : `${keyRing}/cryptoKeys/_`,
    );
    return {
      parent: parsed.keyRing,
      location: parsed.location,
      project: parsed.project || project,
    };
  }
  const loc = normalizeLocation(location);
  return {
    parent: `projects/${project}/locations/${loc}/keyRings/${keyRing}`,
    location: loc,
    project,
  };
};

const resourceName = (parent: string, cryptoKeyId: string) =>
  `${parent}/cryptoKeys/${cryptoKeyId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (id: string, cryptoKeyId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      cryptoKeyId ??
      existing ??
      (yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }))
    );
  });

const toAttrs = (key: kms.CryptoKey, project: string): CryptoKeyAttrs => {
  const name = key.name ?? "";
  const parsed = parseName(name);
  const template = key.versionTemplate;
  return {
    name,
    cryptoKeyId: parsed.cryptoKeyId,
    keyRing: parsed.keyRing,
    location: parsed.location,
    project: parsed.project || project,
    purpose: key.purpose ?? DEFAULT_PURPOSE,
    labels: userLabels(key.labels),
    versionTemplate:
      template === undefined
        ? undefined
        : {
            algorithm: template.algorithm,
            protectionLevel: template.protectionLevel,
          },
    rotationPeriod: key.rotationPeriod,
    nextRotationTime: key.nextRotationTime,
    destroyScheduledDuration: key.destroyScheduledDuration,
    importOnly: key.importOnly === true,
    cryptoKeyBackend: key.cryptoKeyBackend,
    primaryVersion: key.primary?.name,
    createTime: key.createTime,
  };
};

const getByName = (name: string) =>
  kms
    .getProjectsLocationsKeyRingsCryptoKeys({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const paginate = <A, E, R>(
  fetch: (
    pageToken: string | undefined,
  ) => Effect.Effect<{ items: A[]; nextPageToken?: string }, E, R>,
) =>
  Effect.gen(function* () {
    const found: A[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* fetch(pageToken);
      found.push(...response.items);
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  });

const listKeyRingsAt = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRings({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.keyRings ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.KeyRing[],
            nextPageToken: undefined,
          }),
        ),
        Effect.catchTag("Forbidden", () =>
          Effect.succeed({
            items: [] as kms.KeyRing[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listKeysInRing = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRingsCryptoKeys({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: (response.cryptoKeys ?? []).filter((key) =>
            Object.keys(key.labels ?? {}).some((label) =>
              label.startsWith("alchemy-"),
            ),
          ),
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.CryptoKey[],
            nextPageToken: undefined,
          }),
        ),
        Effect.catchTag("Forbidden", () =>
          Effect.succeed({
            items: [] as kms.CryptoKey[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const listCryptoKeysAt = (locationParent: string) =>
  Effect.gen(function* () {
    const rings = yield* listKeyRingsAt(locationParent);
    const pages = yield* Effect.forEach(
      rings,
      (ring) =>
        ring.name
          ? listKeysInRing(ring.name)
          : Effect.succeed([] as kms.CryptoKey[]),
      { concurrency: 4 },
    );
    return pages.flat();
  });

const listVersions = (parent: string) =>
  paginate((pageToken) =>
    kms
      .listProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
        parent,
        pageSize: 1000,
        pageToken,
      })
      .pipe(
        Effect.map((response) => ({
          items: response.cryptoKeyVersions ?? [],
          nextPageToken: response.nextPageToken,
        })),
        Effect.catchTag("NotFound", () =>
          Effect.succeed({
            items: [] as kms.CryptoKeyVersion[],
            nextPageToken: undefined,
          }),
        ),
      ),
  );

const waitOperation = (
  operation: kms.Operation,
): Effect.Effect<
  kms.Operation,
  | CryptoKeyOperationFailed
  | CryptoKeyOperationPending
  | kms.GetProjectsLocationsOperationsError,
  kms.GcpOpContext
> =>
  Effect.gen(function* () {
    if (operation.done === true) {
      const status = operation.error;
      if (status) {
        return yield* new CryptoKeyOperationFailed({
          operation: operation.name ?? "",
          message: status.message ?? "KMS operation failed",
        });
      }
      return operation;
    }
    const name = operation.name;
    if (name === undefined) {
      return operation;
    }
    const wait: Effect.Effect<
      kms.Operation,
      | CryptoKeyOperationFailed
      | CryptoKeyOperationPending
      | kms.GetProjectsLocationsOperationsError,
      kms.GcpOpContext
    > = kms.getProjectsLocationsOperations({ name }).pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        (): CryptoKeyOperationPending =>
          new CryptoKeyOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => current.error === undefined,
        (current): CryptoKeyOperationFailed =>
          new CryptoKeyOperationFailed({
            operation: name,
            message: current.error?.message ?? "KMS operation failed",
          }),
      ),
    );
    return yield* wait.pipe(
      Effect.retry({
        while: (error) => error._tag === "GCP.KMS.CryptoKeyOperationPending",
        times: 8,
        schedule: Schedule.exponential("500 millis"),
      }),
    );
  });

const waitPrimaryReady = (
  name: string,
): Effect.Effect<
  kms.CryptoKey,
  | CryptoKeyNotResolved
  | CryptoKeyOperationFailed
  | CryptoKeyVersionPending
  | kms.GetProjectsLocationsKeyRingsCryptoKeysError,
  kms.GcpOpContext
> => {
  const probe: Effect.Effect<
    kms.CryptoKey,
    | CryptoKeyNotResolved
    | CryptoKeyOperationFailed
    | CryptoKeyVersionPending
    | kms.GetProjectsLocationsKeyRingsCryptoKeysError,
    kms.GcpOpContext
  > = getByName(name).pipe(
    Effect.flatMap(
      (
        key,
      ): Effect.Effect<
        kms.CryptoKey,
        | CryptoKeyNotResolved
        | CryptoKeyOperationFailed
        | CryptoKeyVersionPending
      > => {
        if (key === undefined) {
          return Effect.fail(new CryptoKeyNotResolved({ name }));
        }
        const state = key.primary?.state;
        if (state === undefined || state === "ENABLED") {
          return Effect.succeed(key);
        }
        if (state === "GENERATION_FAILED") {
          return Effect.fail(
            new CryptoKeyOperationFailed({
              operation: key.primary?.name ?? name,
              message: key.primary?.generationFailureReason ?? state,
            }),
          );
        }
        return Effect.fail(
          new CryptoKeyVersionPending({
            name,
            state,
          }),
        );
      },
    ),
  );
  return probe.pipe(
    Effect.retry({
      while: (error) => error._tag === "GCP.KMS.CryptoKeyVersionPending",
      times: 8,
      schedule: Schedule.spaced("500 millis"),
    }),
  );
};

const desiredAlgorithm = (
  purpose: kms.CryptoKeyPurposeEnum,
  template: CryptoKeyVersionTemplate | undefined,
) =>
  template?.algorithm ??
  (purpose === "ENCRYPT_DECRYPT" ? DEFAULT_ALGORITHM : template?.algorithm);

const nextRotationFromPeriod = (period: string) =>
  Effect.sync(() => {
    const match = /^(\d+)s$/.exec(period);
    const seconds = match ? Number(match[1]) : 86_400;
    return new Date(Date.now() + seconds * 1000).toISOString();
  });

const destroyVersion = (name: string) =>
  kms
    .destroyProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({
      name,
      body: {},
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.catchTag("BadRequest", () => Effect.void),
      Effect.catchTag("Conflict", () => Effect.void),
    );

const deleteVersion = (name: string) =>
  kms.deleteProjectsLocationsKeyRingsCryptoKeysCryptoKeyVersions({ name }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
    Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
    Effect.flatMap(
      (
        operation,
      ): Effect.Effect<
        void,
        | CryptoKeyOperationFailed
        | CryptoKeyOperationPending
        | kms.GetProjectsLocationsOperationsError,
        kms.GcpOpContext
      > =>
        operation === undefined
          ? Effect.void
          : waitOperation(operation).pipe(Effect.asVoid),
    ),
  );

const clearRotation = (name: string, current: kms.CryptoKey) => {
  if (!current.rotationPeriod && !current.nextRotationTime) {
    return Effect.void;
  }
  return kms
    .patchProjectsLocationsKeyRingsCryptoKeys({
      name,
      updateMask: "rotationPeriod,nextRotationTime",
      body: {},
    })
    .pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.asVoid,
    );
};

export const CryptoKeyProvider = () =>
  Provider.succeed(CryptoKey, {
    stables: [
      "name",
      "cryptoKeyId",
      "keyRing",
      "location",
      "project",
      "purpose",
      "destroyScheduledDuration",
      "importOnly",
      "cryptoKeyBackend",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.cryptoKeyId ?? output?.cryptoKeyId;
      const nextId = news.cryptoKeyId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        nextId !== undefined &&
        nextId !== previousId;

      const previousParent =
        output?.keyRing ??
        (olds?.keyRing
          ? resolveParent("", olds.keyRing, olds.location).parent
          : undefined);
      const nextParent = resolveParent(
        output?.project ?? "",
        news.keyRing,
        news.location ?? output?.location,
      ).parent;
      const parentChanged =
        previousParent !== undefined && previousParent !== nextParent;

      const previousPurpose =
        olds?.purpose ?? output?.purpose ?? DEFAULT_PURPOSE;
      const nextPurpose = news.purpose ?? DEFAULT_PURPOSE;
      const previousProtection = normalizeProtection(
        olds?.versionTemplate?.protectionLevel ??
          output?.versionTemplate?.protectionLevel,
      );
      const nextProtection = normalizeProtection(
        news.versionTemplate?.protectionLevel,
      );
      const previousImportOnly =
        olds?.importOnly ?? output?.importOnly ?? false;
      const nextImportOnly = news.importOnly === true;
      const previousDuration =
        olds?.destroyScheduledDuration ?? output?.destroyScheduledDuration;
      const nextDuration = news.destroyScheduledDuration;
      const previousBackend =
        olds?.cryptoKeyBackend ?? output?.cryptoKeyBackend;
      const nextBackend = news.cryptoKeyBackend;

      const replace =
        idChanged ||
        parentChanged ||
        previousPurpose !== nextPurpose ||
        previousProtection !== nextProtection ||
        previousImportOnly !== nextImportOnly ||
        (previousDuration !== undefined &&
          nextDuration !== undefined &&
          previousDuration !== nextDuration) ||
        (previousBackend ?? "") !== (nextBackend ?? "");

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousId !== undefined && nextId === previousId && !parentChanged,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const cryptoKeyId = yield* toId(
        id,
        olds?.cryptoKeyId,
        output?.cryptoKeyId,
      );
      const name =
        output?.name ??
        (olds?.keyRing || output?.keyRing
          ? resourceName(
              resolveParent(
                env.project,
                olds?.keyRing ?? output?.keyRing ?? "",
                olds?.location ?? output?.location,
              ).parent,
              cryptoKeyId,
            )
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const found: ReturnType<typeof toAttrs>[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* kms.listProjectsLocations({
            name: `projects/${env.project}`,
            pageSize: 100,
            pageToken,
          });
          const parents = (response.locations ?? [])
            .map((location) => location.name)
            .filter((name): name is string => !!name);
          const batches = yield* Effect.forEach(
            parents,
            (parent) => listCryptoKeysAt(parent),
            { concurrency: 4 },
          );
          for (const keys of batches) {
            for (const key of keys) {
              found.push(toAttrs(key, env.project));
            }
          }
          pageToken = response.nextPageToken;
          if (pageToken === undefined || pageToken === "") break;
        }
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const cryptoKeyId = yield* toId(
        id,
        news.cryptoKeyId,
        output?.cryptoKeyId,
      );
      const parent = resolveParent(
        env.project,
        news.keyRing,
        news.location ?? output?.location,
      );
      const name = resourceName(parent.parent, cryptoKeyId);
      const purpose = news.purpose ?? DEFAULT_PURPOSE;
      const algorithm = desiredAlgorithm(purpose, news.versionTemplate);
      const protectionLevel = news.versionTemplate?.protectionLevel;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const rotationPeriod = news.rotationPeriod;
      const nextRotationTime = rotationPeriod
        ? (news.nextRotationTime ??
          (yield* nextRotationFromPeriod(rotationPeriod)))
        : news.nextRotationTime;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* kms
          .createProjectsLocationsKeyRingsCryptoKeys({
            parent: parent.parent,
            cryptoKeyId,
            skipInitialVersionCreation: news.skipInitialVersionCreation,
            body: {
              purpose,
              labels: desiredLabels,
              versionTemplate: {
                algorithm,
                protectionLevel,
              },
              rotationPeriod,
              nextRotationTime,
              destroyScheduledDuration: news.destroyScheduledDuration,
              importOnly: news.importOnly,
              cryptoKeyBackend: news.cryptoKeyBackend,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
        if (
          current !== undefined &&
          news.skipInitialVersionCreation !== true &&
          current.primary?.state === "PENDING_GENERATION"
        ) {
          current = yield* waitPrimaryReady(name);
        }
      }

      if (current === undefined) {
        return yield* new CryptoKeyNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const observedAlgorithm = current.versionTemplate?.algorithm;
      const algorithmChanged =
        algorithm !== undefined && observedAlgorithm !== algorithm;
      const rotationChanged =
        (current.rotationPeriod ?? "") !== (rotationPeriod ?? "") ||
        (news.nextRotationTime !== undefined &&
          (current.nextRotationTime ?? "") !== news.nextRotationTime);

      if (labelsChanged || algorithmChanged || rotationChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          algorithmChanged ? "versionTemplate.algorithm" : undefined,
          rotationChanged ? "rotationPeriod" : undefined,
          rotationChanged ? "nextRotationTime" : undefined,
        ]
          .filter((field): field is string => field !== undefined)
          .join(",");
        current = yield* kms.patchProjectsLocationsKeyRingsCryptoKeys({
          name,
          updateMask,
          body: {
            labels: desiredLabels,
            versionTemplate: algorithmChanged
              ? {
                  algorithm,
                  protectionLevel:
                    protectionLevel ?? current.versionTemplate?.protectionLevel,
                }
              : undefined,
            rotationPeriod,
            nextRotationTime,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      const current = yield* getByName(name);
      if (current === undefined) return;

      yield* clearRotation(name, current);

      const versions = yield* listVersions(name);
      yield* Effect.forEach(
        versions,
        (version) => {
          const versionName = version.name;
          if (versionName === undefined) return Effect.void;
          const state = version.state ?? "";
          if (DESTROYABLE_VERSION_STATES.has(state)) {
            return destroyVersion(versionName);
          }
          if (DELETABLE_VERSION_STATES.has(state)) {
            return deleteVersion(versionName);
          }
          return Effect.void;
        },
        { concurrency: 4 },
      );

      const remaining = yield* listVersions(name);
      const stillDeletable = remaining.filter((version) =>
        DELETABLE_VERSION_STATES.has(version.state ?? ""),
      );
      yield* Effect.forEach(
        stillDeletable,
        (version) => (version.name ? deleteVersion(version.name) : Effect.void),
        { concurrency: 4 },
      );

      const leftover = yield* listVersions(name);
      if (leftover.length > 0) {
        // DESTROY_SCHEDULED versions cannot be removed until the
        // destroyScheduledDuration (min 24h) elapses. Leave the key;
        // nuke will retry after versions reach DESTROYED.
        return;
      }

      const deleted = yield* kms
        .deleteProjectsLocationsKeyRingsCryptoKeys({ name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          // Versions can appear between the list and delete, or the name
          // may already be retired. Either way the key is gone or stuck
          // until versions reach DESTROYED — not a delete failure.
          Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
          Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
        );
      if (deleted !== undefined) {
        yield* waitOperation(deleted);
      }
    }),
  });
