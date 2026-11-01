import * as kms from "@distilled.cloud/stackit/kms";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  generatedKmsName,
  getKeyOrUndefined,
  isGeneratedKmsName,
  kmsDescriptionChanged,
  KMS_TIMEOUT,
  latestActiveVersion,
  listGeneratedKeyRings,
  listLiveKeys,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

/** The system protecting a key's material. */
export type KeyProtection = "software" | "hsm";

/** Access scope of a key, as STACKIT names it. */
export type KeyAccessScope = "PUBLIC" | "SNA";

export interface KeyProps extends ProjectScopedProps {
  /** Key ring holding the key. Changing it replaces the key. */
  keyRingId: string;
  /**
   * Display name, up to 64 of letters, digits, `_` and `-`. STACKIT has no
   * update operation, so changing it replaces the key.
   *
   * An explicit name is not proof of ownership: a key of that name in the ring
   * that isn't in state is refused until you pass `--adopt`.
   *
   * @default a physical name generated from the app, stage, logical id and
   * instance id
   */
  displayName?: string;
  /**
   * Description, up to 256 characters. STACKIT has no update operation, so
   * changing it replaces the key, which loses access to everything encrypted
   * with the old one once its deletion date passes. An empty string counts as
   * no description.
   */
  description?: string;
  /** Algorithm of the key material. Must suit `purpose`. Changing it replaces the key. */
  algorithm: kms.Algorithm;
  /** What the key is for. Must suit `algorithm`. Changing it replaces the key. */
  purpose: kms.Purpose;
  /**
   * System protecting the key material. Changing it replaces the key.
   * @default "software"
   */
  protection?: KeyProtection;
  /**
   * Access scope of the key. Changing it replaces the key.
   * @default "PUBLIC"
   */
  accessScope?: KeyAccessScope;
  /**
   * Whether versions can only be imported. Such a key has no version until
   * `Stackit.KMS.ImportKey` uploads one. Changing it replaces the key.
   * @default false
   */
  importOnly?: boolean;
  /** Project that owns the key. Defaults to the profile's project. Changing it replaces the key. */
  projectId?: string;
  /** Region of the key. Defaults to the profile's region. Changing it replaces the key. */
  region?: string;
}

export interface KeyAttributes {
  /** STACKIT key id (UUID). A replacement gets a new one. */
  keyId: string;
  /** Key ring holding the key. */
  keyRingId: string;
  /** Project that owns the key. */
  projectId: string;
  /** Region of the key. */
  region: string;
  /** Display name of the key. */
  displayName: string;
  /** Description of the key, if any. */
  description: string | undefined;
  /** Algorithm of the key material. */
  algorithm: string;
  /** What the key is for. */
  purpose: string;
  /** System protecting the key material. */
  protection: string;
  /** Access scope of the key. */
  accessScope: string;
  /** Whether versions can only be imported. */
  importOnly: boolean;
  /** State of the key: `active` after a deploy, or `no_version` when import-only. */
  state: string;
  /** When the key was created (RFC 3339). */
  createdAt: string;
  /** Scheduled deletion date, when the key is pending deletion. */
  deletionDate: string | undefined;
  /**
   * Number of the newest active version, as of the last deploy; `undefined`
   * when none is active, as on an import-only key before its first import. A
   * rotation from a binding shows up here at the next deploy.
   */
  latestVersion: number | undefined;
}

export type Key = Resource<"Stackit.KMS.Key", KeyProps, KeyAttributes, never, Providers>;

/**
 * A STACKIT KMS key: versioned key material for encryption, signing or message
 * authentication, used through bindings such as `Stackit.KMS.Encrypt`.
 *
 * STACKIT has no update operation for keys, so every prop replaces the key. KMS
 * has no labels: Alchemy owns a key through the id in its state or a generated
 * name. A key with the same explicit `displayName` is reported as unowned and
 * only taken over with `--adopt`.
 *
 * Deleting a key only schedules its deletion for a `deletionDate` STACKIT picks,
 * and STACKIT's `RestoreKey` operation can undo that in the meantime. Alchemy
 * treats a key pending deletion as gone: it never restores one, and never reuses
 * one for a new deployment. Alchemy destroys no key material itself; that only
 * happens through the `Stackit.KMS.DestroyVersion` binding.
 *
 * ### Creating a Key
 * **Example:** Symmetric data encryption key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {});
 * const key = yield* Stackit.KMS.Key("DataKey", {
 *   keyRingId: ring.keyRingId,
 *   algorithm: "aes_256_gcm",
 *   purpose: "symmetric_encrypt_decrypt",
 * });
 * ```
 *
 * **Example:** Asymmetric signing key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {});
 * const key = yield* Stackit.KMS.Key("SigningKey", {
 *   keyRingId: ring.keyRingId,
 *   algorithm: "ecdsa_p256_sha256",
 *   purpose: "asymmetric_sign_verify",
 *   description: "Signs release manifests",
 * });
 * ```
 *
 * **Example:** Key for your own material
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {});
 * const key = yield* Stackit.KMS.Key("ImportedKey", {
 *   keyRingId: ring.keyRingId,
 *   algorithm: "aes_256_gcm",
 *   purpose: "symmetric_encrypt_decrypt",
 *   importOnly: true,
 * });
 * ```
 *
 * ### Encrypting from a Worker
 * **Example:** Round trip through a key from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const DataKey = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.Key("DataKey", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "aes_256_gcm",
 *       purpose: "symmetric_encrypt_decrypt",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const key = yield* DataKey;
 *     const encrypt = yield* Stackit.KMS.Encrypt(key);
 *     const decrypt = yield* Stackit.KMS.Decrypt(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { ciphertext, version } = yield* encrypt({
 *           plaintext: new TextEncoder().encode("hello"),
 *         });
 *         const { plaintext } = yield* decrypt({ ciphertext, version });
 *         return yield* HttpServerResponse.json({
 *           text: new TextDecoder().decode(Redacted.value(plaintext)),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(Layer.mergeAll(Stackit.KMS.EncryptHttp, Stackit.KMS.DecryptHttp)),
 *   ),
 * ) {}
 * ```
 *
 * ### Using the Key from Other STACKIT Services
 * **Example:** Encrypt a volume with the key's newest version
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {});
 * const key = yield* Stackit.KMS.Key("VolumeKey", {
 *   keyRingId: ring.keyRingId,
 *   algorithm: "aes_256_gcm",
 *   purpose: "symmetric_encrypt_decrypt",
 * });
 * const account = yield* Stackit.IAM.ServiceAccount("VolumeKeyUser", {});
 * const volume = yield* Stackit.IaaS.Volume("Data", {
 *   size: 10,
 *   encryption: {
 *     kekKeyId: key.keyId,
 *     kekKeyringId: key.keyRingId,
 *     kekKeyVersion: key.latestVersion.as<number>(),
 *     serviceAccount: account.email,
 *   },
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** A replaced key can't decrypt the old ciphertext
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Every prop replaces the key, the description included. A replacement is new
 * // key material: data encrypted with the old key can't be decrypted with the
 * // new one, and the old key is scheduled for deletion. Re-encrypt your data
 * // before its deletion date; check `Stackit.KMS.GetKey` for that date, and
 * // restore the old key through the STACKIT API if you missed something.
 * //
 * // With a generated name, the new key exists before the old one is scheduled
 * // for deletion. With an unchanged explicit `displayName`, the old one goes first.
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {});
 * const key = yield* Stackit.KMS.Key("DataKey", {
 *   keyRingId: ring.keyRingId,
 *   algorithm: "aes_256_gcm",
 *   purpose: "symmetric_encrypt_decrypt",
 *   description: "Changing this text replaces the key",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Key Management Service
 * @category KMS
 */
export const Key = Resource<Key>("Stackit.KMS.Key");

const DEFAULT_PROTECTION: KeyProtection = "software";
const DEFAULT_ACCESS_SCOPE: KeyAccessScope = "PUBLIC";

const keyRequest = (scope: ProjectScope, keyRingId: string, keyId: string) => ({
  projectId: scope.projectId,
  regionId: scope.region,
  keyRingId,
  keyId,
});

const toAttrs = (
  scope: ProjectScope,
  key: kms.Key,
  versions: ReadonlyArray<kms.Version>,
): KeyAttributes => ({
  keyId: key.id,
  keyRingId: key.keyRingId,
  projectId: scope.projectId,
  region: scope.region,
  displayName: key.displayName,
  description: key.description === "" ? undefined : key.description,
  algorithm: key.algorithm,
  purpose: key.purpose,
  protection: key.protection,
  accessScope: key.access_scope,
  importOnly: key.importOnly,
  state: key.state,
  createdAt: key.createdAt,
  deletionDate: key.deletionDate,
  latestVersion: latestActiveVersion(versions),
});

const listVersionsOf = (scope: ProjectScope, keyRingId: string, keyId: string) =>
  kms
    .listVersions(keyRequest(scope, keyRingId, keyId))
    .pipe(Effect.map(({ versions }) => versions));

/** The attributes of a live key: `latestVersion` isn't on the key itself. */
const observeAttrs = (scope: ProjectScope, key: kms.Key) =>
  listVersionsOf(scope, key.keyRingId, key.id).pipe(
    Effect.map((versions) => toAttrs(scope, key, versions)),
  );

/**
 * Wait until a key settles. `no_version` is only expected of an import-only key,
 * except on a key that already existed: all its versions may have been destroyed
 * on purpose, and that must not fail a deploy.
 */
const waitForKey = (scope: ProjectScope, key: kms.Key, options: { readonly fresh: boolean }) =>
  waitFor({
    resource: `STACKIT KMS key ${key.id}`,
    read: kms.getKey(keyRequest(scope, key.keyRingId, key.id)),
    ready: (observed) =>
      observed.state === "active" ||
      (observed.state === "no_version" && (observed.importOnly || !options.fresh)),
    failed: (observed) =>
      observed.state === "errors_exist" ||
      observed.state === "not_available" ||
      observed.state === "deleted",
    state: (observed) => observed.state,
    timeout: KMS_TIMEOUT,
  });

/** A new key's first version settles after the key does: wait so `latestVersion` is real. */
const waitForFirstVersion = (scope: ProjectScope, key: kms.Key) =>
  waitFor({
    resource: `STACKIT KMS key ${key.id} first version`,
    read: listVersionsOf(scope, key.keyRingId, key.id),
    ready: (versions) => latestActiveVersion(versions) !== undefined,
    failed: (versions) =>
      versions.find(
        (version) =>
          version.state === "key_material_invalid" || version.state === "key_material_unavailable",
      )?.state,
    state: (versions) => versions.map((version) => version.state).join(","),
    timeout: KMS_TIMEOUT,
  });

export const KeyProvider = () =>
  Provider.succeed(Key, {
    // No update operation exists: only state, deletion date and version change.
    stables: [
      "keyId",
      "keyRingId",
      "projectId",
      "region",
      "displayName",
      "description",
      "algorithm",
      "purpose",
      "protection",
      "accessScope",
      "importOnly",
      "createdAt",
    ],
    nuke: { dependsOn: ["Stackit.KMS.KeyRing"] },

    // Only keys with a generated name in a ring with a generated name: `delete`
    // schedules the end of the key material, so a shape match on the ring alone
    // isn't enough to enumerate a hand-made key that lives there.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const rings = yield* listGeneratedKeyRings(scope);
      const keys = yield* Effect.forEach(rings, (ring) => listLiveKeys(scope, ring.id), {
        concurrency: 4,
      });
      return yield* Effect.forEach(
        keys.flat().filter((key) => isGeneratedKmsName(key.displayName)),
        (key) => observeAttrs(scope, key),
        { concurrency: 4 },
      );
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (
        hasUnresolvedTrigger<KeyProps>(news, [
          "keyRingId",
          "displayName",
          "description",
          "algorithm",
          "purpose",
          "protection",
          "accessScope",
          "importOnly",
          "projectId",
          "region",
        ])
      ) {
        // An explicit name can resolve to the current one in the same ring:
        // delete first. A generated name changes with the new generation.
        return {
          action: "replace" as const,
          deleteFirst: rawProp<KeyProps>(news, "displayName") !== undefined,
        };
      }
      if (!isResolved(news)) return undefined;
      const nameChanged =
        news.displayName !== undefined
          ? news.displayName !== output.displayName
          : olds?.displayName !== undefined;
      const descriptionChanged = kmsDescriptionChanged(
        news.description,
        olds?.description,
        output.description,
      );
      const scopeChanged = yield* projectScopeChanged(news, output);
      const ringChanged = news.keyRingId !== output.keyRingId;
      // On adoption (no olds) an unset prop keeps what the key already has: an
      // omitted default must not schedule the deletion of an adopted key.
      const settable = <V>(value: V | undefined, fallback: V, current: unknown) =>
        (value !== undefined || olds !== undefined) && (value ?? fallback) !== current;
      if (
        nameChanged ||
        descriptionChanged ||
        scopeChanged ||
        ringChanged ||
        news.algorithm !== output.algorithm ||
        news.purpose !== output.purpose ||
        settable(news.protection, DEFAULT_PROTECTION, output.protection) ||
        settable(news.accessScope, DEFAULT_ACCESS_SCOPE, output.accessScope) ||
        settable(news.importOnly, false, output.importOnly)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            news.displayName !== undefined && !nameChanged && !ringChanged && !scopeChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      // Tracked in state: ours, or gone. A key pending deletion counts as gone, so
      // it is recreated rather than restored.
      if (output !== undefined) {
        const key = yield* getKeyOrUndefined(scope, output.keyRingId, output.keyId);
        return key === undefined ? undefined : yield* observeAttrs(scope, key);
      }
      if (olds?.keyRingId === undefined) return undefined;
      const explicitName = olds.displayName;
      const displayName = explicitName ?? (yield* generatedKmsName(id));
      // The generation being replaced is never a candidate: garbage collection
      // deletes what `read` hands to a create-first replacement, and here that
      // would schedule the deletion of the key this deploy just returned.
      const keys = yield* listLiveKeys(scope, olds.keyRingId);
      const key = keys.find(
        (candidate) => candidate.displayName === displayName && candidate.id !== previous?.keyId,
      );
      if (key === undefined) return undefined;
      const attrs = yield* observeAttrs(scope, key);
      // A generated name carries this generation's instance id: a crashed create.
      return explicitName === undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const keyRingId = news.keyRingId;
      const displayName = news.displayName ?? output?.displayName ?? (yield* generatedKmsName(id));

      // 1. Observe — the recorded id, while it still names this ring. A generated
      // name also finds a crashed create; an explicit name never claims anything
      // here, because `read` gates that behind `--adopt`.
      let key: kms.Key | undefined;
      if (
        output?.projectId === scope.projectId &&
        output.region === scope.region &&
        output.keyRingId === keyRingId
      ) {
        key = yield* getKeyOrUndefined(scope, keyRingId, output.keyId);
      }
      if (key === undefined && news.displayName === undefined) {
        const keys = yield* listLiveKeys(scope, keyRingId);
        key = keys.find((candidate) => candidate.displayName === displayName);
      }

      // 2. Ensure — there is nothing to sync: a key has no update operation.
      const fresh = key === undefined;
      if (key === undefined) {
        key = yield* kms.createKey({
          projectId: scope.projectId,
          regionId: scope.region,
          keyRingId,
          displayName,
          algorithm: news.algorithm,
          purpose: news.purpose,
          protection: news.protection ?? DEFAULT_PROTECTION,
          access_scope: news.accessScope ?? DEFAULT_ACCESS_SCOPE,
          importOnly: news.importOnly ?? false,
          ...(news.description ? { description: news.description } : {}),
        });
      }
      key = yield* waitForKey(scope, key, { fresh });

      // 3. Return
      const versions =
        fresh && !key.importOnly
          ? yield* waitForFirstVersion(scope, key)
          : yield* listVersionsOf(scope, keyRingId, key.id);
      return toAttrs(scope, key, versions);
    }),

    // Schedules deletion of exactly the key recorded in state; STACKIT keeps the
    // material until `deletionDate`. A key already pending deletion isn't touched.
    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const current = yield* getKeyOrUndefined(scope, output.keyRingId, output.keyId);
      if (current === undefined) return;
      yield* kms.deleteKey(keyRequest(scope, output.keyRingId, output.keyId)).pipe(
        // E.g. the key is still creating.
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          schedule: Schedule.spaced("5 seconds"),
          times: 8,
        }),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT KMS key ${output.keyId}`,
        read: getKeyOrUndefined(scope, output.keyRingId, output.keyId),
        state: (key) => key.state,
        timeout: KMS_TIMEOUT,
      });
    }),
  });
