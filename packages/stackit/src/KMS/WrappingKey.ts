import * as kms from "@distilled.cloud/stackit/kms";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  generatedKmsName,
  getWrappingKeyOrUndefined,
  isGeneratedKmsName,
  kmsDescriptionChanged,
  KMS_TIMEOUT,
  listGeneratedKeyRings,
  listLiveWrappingKeys,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";
import type { KeyAccessScope, KeyProtection } from "./Key.ts";

export interface WrappingKeyProps extends ProjectScopedProps {
  /** Key ring holding the wrapping key. Changing it replaces the wrapping key. */
  keyRingId: string;
  /**
   * Display name, up to 64 of letters, digits, `_` and `-`. Changing it replaces
   * the wrapping key.
   *
   * An explicit name is not proof of ownership: a wrapping key of that name in
   * the ring that isn't in state is refused until you pass `--adopt`.
   *
   * @default a physical name generated from the app, stage, logical id and
   * instance id
   */
  displayName?: string;
  /**
   * Description, up to 256 characters. Changing it replaces the wrapping key. An
   * empty string counts as no description.
   */
  description?: string;
  /** Algorithm used to wrap the material to import. Changing it replaces the wrapping key. */
  algorithm: kms.WrappingAlgorithm;
  /** Kind of key material it wraps. Changing it replaces the wrapping key. */
  purpose: kms.WrappingPurpose;
  /**
   * System protecting the wrapping key. Changing it replaces the wrapping key.
   * @default "software"
   */
  protection?: KeyProtection;
  /**
   * Access scope of the wrapping key. Changing it replaces the wrapping key.
   * @default "PUBLIC"
   */
  accessScope?: KeyAccessScope;
  /** Project that owns the wrapping key. Defaults to the profile's project. Changing it replaces it. */
  projectId?: string;
  /** Region of the wrapping key. Defaults to the profile's region. Changing it replaces it. */
  region?: string;
}

export interface WrappingKeyAttributes {
  /** STACKIT wrapping key id (UUID). Changes when an expired wrapping key is renewed. */
  wrappingKeyId: string;
  /** Key ring holding the wrapping key. */
  keyRingId: string;
  /** Project that owns the wrapping key. */
  projectId: string;
  /** Region of the wrapping key. */
  region: string;
  /** Display name of the wrapping key. */
  displayName: string;
  /** Description of the wrapping key, if any. */
  description: string | undefined;
  /** Wrapping algorithm. */
  algorithm: string;
  /** Kind of key material it wraps. */
  purpose: string;
  /** System protecting the wrapping key. */
  protection: string;
  /** Access scope of the wrapping key. */
  accessScope: string;
  /** Public key to wrap material with. Changes when an expired wrapping key is renewed. */
  publicKey: string | undefined;
  /** When the wrapping key expires (RFC 3339). */
  expiresAt: string;
  /** State of the wrapping key: `active` after a deploy. */
  state: string;
  /** When the wrapping key was created (RFC 3339). */
  createdAt: string;
}

export type WrappingKey = Resource<
  "Stackit.KMS.WrappingKey",
  WrappingKeyProps,
  WrappingKeyAttributes,
  never,
  Providers
>;

/**
 * A STACKIT KMS wrapping key: a public key you encrypt your own key material
 * with, so it can reach `Stackit.KMS.ImportKey` without being exposed on the way.
 *
 * STACKIT has no update operation for wrapping keys, so every prop replaces it.
 * A wrapping key also expires: the first deploy after `expiresAt` deletes it and
 * creates a new one, which changes `wrappingKeyId` and `publicKey` and updates
 * whatever references them. KMS has no labels: Alchemy owns a wrapping key through
 * the id in its state or a generated name. A wrapping key with the same explicit
 * `displayName` is reported as unowned and only taken over with `--adopt`.
 *
 * See [STACKIT's KMS docs](https://docs.stackit.cloud/products/security/kms/).
 *
 * :::caution[Changing any prop replaces the Wrapping Key]
 * STACKIT has no update operation for wrapping keys. The first deploy after
 * `expiresAt` replaces it too, which changes `wrappingKeyId` and `publicKey` and
 * updates whatever references them.
 * :::
 *
 * ### Creating a Wrapping Key
 * **Example:** Wrapping key for symmetric material
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {});
 * const wrappingKey = yield* Stackit.KMS.WrappingKey("Wrapper", {
 *   keyRingId: ring.keyRingId,
 *   algorithm: "rsa_2048_oaep_sha256",
 *   purpose: "wrap_symmetric_key",
 * });
 * ```
 *
 * **Example:** Wrapping key for asymmetric material
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {});
 * const wrappingKey = yield* Stackit.KMS.WrappingKey("Wrapper", {
 *   keyRingId: ring.keyRingId,
 *   algorithm: "rsa_4096_oaep_sha256_aes_256_key_wrap",
 *   purpose: "wrap_asymmetric_key",
 *   description: "Imports our signing keys",
 * });
 * ```
 *
 * ### Importing Key Material
 * **Example:** Read the public key from a Cloudflare Worker, then import
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const Wrapper = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.WrappingKey("Wrapper", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "rsa_2048_oaep_sha256",
 *       purpose: "wrap_symmetric_key",
 *     }),
 *   ),
 * );
 * export const Imported = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.Key("Imported", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "aes_256_gcm",
 *       purpose: "symmetric_encrypt_decrypt",
 *       importOnly: true,
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const wrapper = yield* Wrapper;
 *     const getWrappingKey = yield* Stackit.KMS.GetWrappingKey(wrapper);
 *     const importKey = yield* Stackit.KMS.ImportKey(yield* Imported);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         if (request.method === "GET") {
 *           const { id, publicKey } = yield* getWrappingKey();
 *           return yield* HttpServerResponse.json({ id, publicKey });
 *         }
 *         // The caller wrapped its material with the public key from GET.
 *         const body = yield* request.arrayBuffer;
 *         const { id } = yield* getWrappingKey();
 *         const version = yield* importKey({
 *           wrappedKey: Redacted.make(new Uint8Array(body)),
 *           wrappingKeyId: id,
 *         });
 *         return yield* HttpServerResponse.json({ version: version.number });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(Layer.mergeAll(Stackit.KMS.GetWrappingKeyHttp, Stackit.KMS.ImportKeyHttp)),
 *   ),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT Key Management Service
 * @category KMS
 */
export const WrappingKey = Resource<WrappingKey>("Stackit.KMS.WrappingKey");

const DEFAULT_PROTECTION: KeyProtection = "software";
const DEFAULT_ACCESS_SCOPE: KeyAccessScope = "PUBLIC";

const wrappingKeyRequest = (scope: ProjectScope, keyRingId: string, wrappingKeyId: string) => ({
  projectId: scope.projectId,
  regionId: scope.region,
  keyRingId,
  wrappingKeyId,
});

const toAttrs = (scope: ProjectScope, wrappingKey: kms.WrappingKey): WrappingKeyAttributes => ({
  wrappingKeyId: wrappingKey.id,
  keyRingId: wrappingKey.keyRingId,
  projectId: scope.projectId,
  region: scope.region,
  displayName: wrappingKey.displayName,
  description: wrappingKey.description === "" ? undefined : wrappingKey.description,
  algorithm: wrappingKey.algorithm,
  purpose: wrappingKey.purpose,
  protection: wrappingKey.protection,
  accessScope: wrappingKey.access_scope,
  publicKey: wrappingKey.publicKey,
  expiresAt: wrappingKey.expiresAt,
  state: wrappingKey.state,
  createdAt: wrappingKey.createdAt,
});

const hasExpired = (expiresAt: string, now: number) => new Date(expiresAt).getTime() <= now;

/** Delete a wrapping key and wait until it is gone. Idempotent. */
const deleteAndWait = (scope: ProjectScope, keyRingId: string, wrappingKeyId: string) =>
  Effect.gen(function* () {
    yield* kms.deleteWrappingKey(wrappingKeyRequest(scope, keyRingId, wrappingKeyId)).pipe(
      // E.g. the wrapping key is still creating.
      Effect.retry({
        while: (error) => error._tag === "Conflict",
        schedule: Schedule.spaced("5 seconds"),
        times: 8,
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
    yield* waitUntilGone({
      resource: `STACKIT KMS wrapping key ${wrappingKeyId}`,
      read: getWrappingKeyOrUndefined(scope, keyRingId, wrappingKeyId),
      state: (wrappingKey) => wrappingKey.state,
      timeout: KMS_TIMEOUT,
    });
  });

export const WrappingKeyProvider = () =>
  Provider.succeed(WrappingKey, {
    // `wrappingKeyId` and `publicKey` change when an expired one is renewed.
    stables: [
      "keyRingId",
      "projectId",
      "region",
      "displayName",
      "description",
      "algorithm",
      "purpose",
      "protection",
      "accessScope",
    ],
    nuke: { dependsOn: ["Stackit.KMS.KeyRing"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const rings = yield* listGeneratedKeyRings(scope);
      const wrappingKeys = yield* Effect.forEach(
        rings,
        (ring) => listLiveWrappingKeys(scope, ring.id),
        { concurrency: 4 },
      );
      return wrappingKeys
        .flat()
        .filter((wrappingKey) => isGeneratedKmsName(wrappingKey.displayName))
        .map((wrappingKey) => toAttrs(scope, wrappingKey));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (
        hasUnresolvedTrigger<WrappingKeyProps>(news, [
          "keyRingId",
          "displayName",
          "description",
          "algorithm",
          "purpose",
          "protection",
          "accessScope",
          "projectId",
          "region",
        ])
      ) {
        // An explicit name can resolve to the current one in the same ring:
        // delete first. A generated name changes with the new generation.
        return {
          action: "replace" as const,
          deleteFirst: rawProp<WrappingKeyProps>(news, "displayName") !== undefined,
        };
      }
      const resolved = triggerProps<WrappingKeyProps>(news);
      const nameChanged =
        resolved.displayName !== undefined
          ? resolved.displayName !== output.displayName
          : olds?.displayName !== undefined;
      const descriptionChanged = kmsDescriptionChanged(
        resolved.description,
        olds?.description,
        output.description,
      );
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const ringChanged = resolved.keyRingId !== output.keyRingId;
      const settable = <V>(value: V | undefined, fallback: V, current: unknown) =>
        (value !== undefined || olds !== undefined) && (value ?? fallback) !== current;
      if (
        nameChanged ||
        descriptionChanged ||
        scopeChanged ||
        ringChanged ||
        resolved.algorithm !== output.algorithm ||
        resolved.purpose !== output.purpose ||
        settable(resolved.protection, DEFAULT_PROTECTION, output.protection) ||
        settable(resolved.accessScope, DEFAULT_ACCESS_SCOPE, output.accessScope)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            resolved.displayName !== undefined && !nameChanged && !ringChanged && !scopeChanged,
        };
      }
      // An expired wrapping key is useless: reconcile renews it in place.
      const now = yield* Clock.currentTimeMillis;
      if (output.state === "expired" || hasExpired(output.expiresAt, now)) {
        return { action: "update" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output !== undefined) {
        const wrappingKey = yield* getWrappingKeyOrUndefined(
          scope,
          output.keyRingId,
          output.wrappingKeyId,
        );
        return wrappingKey === undefined ? undefined : toAttrs(scope, wrappingKey);
      }
      if (olds?.keyRingId === undefined) return undefined;
      const explicitName = olds.displayName;
      const displayName = explicitName ?? (yield* generatedKmsName(id));
      // The generation being replaced is never a candidate: garbage collection
      // deletes what `read` hands to a create-first replacement.
      const wrappingKeys = yield* listLiveWrappingKeys(scope, olds.keyRingId);
      const wrappingKey = wrappingKeys.find(
        (candidate) =>
          candidate.displayName === displayName && candidate.id !== previous?.wrappingKeyId,
      );
      if (wrappingKey === undefined) return undefined;
      const attrs = toAttrs(scope, wrappingKey);
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
      let wrappingKey: kms.WrappingKey | undefined;
      if (
        output?.projectId === scope.projectId &&
        output.region === scope.region &&
        output.keyRingId === keyRingId
      ) {
        wrappingKey = yield* getWrappingKeyOrUndefined(scope, keyRingId, output.wrappingKeyId);
      }
      if (wrappingKey === undefined && news.displayName === undefined) {
        const wrappingKeys = yield* listLiveWrappingKeys(scope, keyRingId);
        wrappingKey = wrappingKeys.find((candidate) => candidate.displayName === displayName);
      }

      // An expired wrapping key can't wrap anything: renew it. It got here through
      // the id in state, a generated name or `--adopt`, so it is ours to delete.
      const now = yield* Clock.currentTimeMillis;
      if (
        wrappingKey !== undefined &&
        (wrappingKey.state === "expired" || hasExpired(wrappingKey.expiresAt, now))
      ) {
        yield* deleteAndWait(scope, keyRingId, wrappingKey.id);
        wrappingKey = undefined;
      }

      // 2. Ensure — there is nothing to sync: a wrapping key has no update operation.
      if (wrappingKey === undefined) {
        wrappingKey = yield* kms.createWrappingKey({
          projectId: scope.projectId,
          regionId: scope.region,
          keyRingId,
          displayName,
          algorithm: news.algorithm,
          purpose: news.purpose,
          protection: news.protection ?? DEFAULT_PROTECTION,
          access_scope: news.accessScope ?? DEFAULT_ACCESS_SCOPE,
          ...(news.description ? { description: news.description } : {}),
        });
      }
      const wrappingKeyId = wrappingKey.id;
      if (wrappingKey.state !== "active") {
        wrappingKey = yield* waitFor({
          resource: `STACKIT KMS wrapping key ${wrappingKeyId}`,
          read: kms.getWrappingKey(wrappingKeyRequest(scope, keyRingId, wrappingKeyId)),
          ready: (observed) => observed.state === "active",
          failed: (observed) =>
            observed.state === "key_material_unavailable" ||
            observed.state === "expired" ||
            observed.state === "deleted",
          state: (observed) => observed.state,
          timeout: KMS_TIMEOUT,
        });
      }

      // 3. Return
      return toAttrs(scope, wrappingKey);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const current = yield* getWrappingKeyOrUndefined(
        scope,
        output.keyRingId,
        output.wrappingKeyId,
      );
      if (current !== undefined)
        yield* deleteAndWait(scope, output.keyRingId, output.wrappingKeyId);
    }),
  });
