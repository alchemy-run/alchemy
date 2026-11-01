import * as kms from "@distilled.cloud/stackit/kms";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import { projectScopeChanged, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import { waitFor } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  generatedKmsName,
  getKeyRingOrUndefined,
  isKeyPendingDeletion,
  kmsDescriptionChanged,
  KMS_TIMEOUT,
  listGeneratedKeyRings,
  listLiveKeyRings,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

/**
 * STACKIT refused to delete a key ring that still holds a live key or wrapping
 * key. Alchemy deletes the contents it owns before the ring, so whatever is left
 * was not created by this stack, or is the live generation of a replacement.
 */
export class KeyRingNotEmpty extends Data.TaggedError("Stackit.KMS.KeyRingNotEmpty")<{
  readonly resourceName: string;
  readonly keyRingId: string;
  readonly liveIds: readonly string[];
  readonly message: string;
}> {}

export interface KeyRingProps extends ProjectScopedProps {
  /**
   * Display name, up to 64 of letters, digits, `_` and `-`. STACKIT has no
   * update operation, so changing it replaces the ring.
   *
   * An explicit name is not proof of ownership: when a ring of that name exists
   * and isn't in state, the deploy refuses it until you pass `--adopt`. That
   * includes a ring a previous destroy had to leave behind (see "Deleting a Key
   * Ring"), so prefer the generated name.
   *
   * @default a physical name generated from the app, stage, logical id and
   * instance id
   */
  displayName?: string;
  /**
   * Description, up to 256 characters. Changing it replaces the ring. An empty
   * string counts as no description.
   */
  description?: string;
  /** Project that owns the ring. Defaults to the profile's project. Changing it replaces the ring. */
  projectId?: string;
  /** Region of the ring. Defaults to the profile's region. Changing it replaces the ring. */
  region?: string;
}

export interface KeyRingAttributes {
  /** STACKIT key ring id (UUID). */
  keyRingId: string;
  /** Project that owns the ring. */
  projectId: string;
  /** Region of the ring. */
  region: string;
  /** Display name of the ring. */
  displayName: string;
  /** Description of the ring, if any. */
  description: string | undefined;
  /** State of the ring: `active` after a deploy. */
  state: string;
  /** When the ring was created (RFC 3339). */
  createdAt: string;
}

export type KeyRing = Resource<
  "Stackit.KMS.KeyRing",
  KeyRingProps,
  KeyRingAttributes,
  never,
  Providers
>;

/**
 * A STACKIT KMS key ring: the container of `Stackit.KMS.Key` and
 * `Stackit.KMS.WrappingKey`, scoped to a project and region.
 *
 * STACKIT has no update operation for key rings, so every prop replaces the
 * ring, and replacing a ring replaces the keys in it. KMS has no labels: Alchemy
 * owns a ring through the id in its state or a generated name. A ring with the
 * same explicit `displayName` is reported as unowned and only taken over with
 * `--adopt`.
 *
 * ### Creating a Key Ring
 * **Example:** Key ring with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {
 *   description: "Application encryption keys",
 * });
 * ```
 *
 * **Example:** Key ring with an explicit name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {
 *   displayName: "payments-keys",
 *   region: "eu01",
 * });
 * ```
 *
 * ### Adding Keys
 * **Example:** A ring with a data encryption key
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
 * ### Deleting a Key Ring
 * **Example:** A destroy can leave the ring behind
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // STACKIT deletes only empty rings, and a key pending deletion still counts.
 * // So a destroy of this stack schedules the key's deletion, logs a warning for
 * // the ring and removes it from state. The empty ring stays in the project
 * // until the key's deletion date has passed; `alchemy unsafe nuke` retries it.
 * // The next deploy creates a new ring under a new generated name.
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {});
 * const key = yield* Stackit.KMS.Key("DataKey", {
 *   keyRingId: ring.keyRingId,
 *   algorithm: "aes_256_gcm",
 *   purpose: "symmetric_encrypt_decrypt",
 * });
 * ```
 *
 * **Example:** Reusing an explicit name after a destroy
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * // The left-behind ring looks foreign to the next deploy, which refuses it.
 * // Take it over explicitly (or pass `--adopt`), or choose another name.
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {
 *   displayName: "payments-keys",
 * }).pipe(adopt(true));
 * ```
 *
 * ### Replacement Cautions
 * **Example:** A new name moves the keys to a new ring
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new explicit name creates the new ring first, so its keys can be replaced
 * // into it. Replacing a ring and keeping its explicit name (changing only the
 * // description) has to delete the old ring first, and fails with
 * // `KeyRingNotEmpty` while it holds live keys. Change the name as well.
 * // Either way the keys are new keys: see the caution on `Stackit.KMS.Key`.
 * const ring = yield* Stackit.KMS.KeyRing("Ring", {
 *   displayName: "payments-keys-v2",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Key Management Service
 * @category KMS
 */
export const KeyRing = Resource<KeyRing>("Stackit.KMS.KeyRing");

const toAttrs = (scope: ProjectScope, ring: kms.KeyRing): KeyRingAttributes => ({
  keyRingId: ring.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: ring.displayName,
  description: ring.description === "" ? undefined : ring.description,
  state: ring.state,
  createdAt: ring.createdAt,
});

/**
 * Delete a ring. On `Conflict`, the ring holds something: when that is only keys
 * pending deletion it can't be deleted until they are gone, so it is left behind
 * with a warning. Anything live is a real failure, retried briefly in case its
 * delete hasn't settled.
 */
const deleteKeyRingOrLeaveBehind = (scope: ProjectScope, ring: KeyRingAttributes) =>
  kms
    .deleteKeyRing({
      projectId: scope.projectId,
      regionId: scope.region,
      keyRingId: ring.keyRingId,
    })
    .pipe(
      Effect.catchTag("Conflict", () =>
        Effect.gen(function* () {
          const request = {
            projectId: scope.projectId,
            regionId: scope.region,
            keyRingId: ring.keyRingId,
          };
          const { keys } = yield* kms.listKeys(request);
          const { wrappingKeys } = yield* kms.listWrappingKeys(request);
          const pending = keys.filter(isKeyPendingDeletion);
          const liveIds = [
            ...keys.filter((key) => !isKeyPendingDeletion(key)),
            ...wrappingKeys.filter((wrappingKey) => wrappingKey.state !== "deleted"),
          ].map((item) => item.id);
          // Nothing live and nothing pending explains no conflict: not ours to drop.
          if (liveIds.length > 0 || pending.length === 0) {
            return yield* new KeyRingNotEmpty({
              resourceName: ring.displayName,
              keyRingId: ring.keyRingId,
              liveIds,
              message:
                `STACKIT KMS key ring ${ring.displayName} (${ring.keyRingId}) can't be deleted: ` +
                (liveIds.length > 0
                  ? `it still holds ${liveIds.join(", ")}. A ring replaced under the same ` +
                    "displayName has to be deleted before its keys are; change the displayName too."
                  : "STACKIT reports a conflict, but the ring holds nothing."),
            });
          }
          const lastDeletion = pending
            .map((key) => key.deletionDate)
            .filter((date) => date !== undefined)
            .sort()
            .at(-1);
          yield* Effect.logWarning(
            `STACKIT KMS key ring ${ring.displayName} (${ring.keyRingId}) was left in the project: ` +
              `${pending.length} of its key(s) are pending deletion, which keeps the ring non-empty` +
              `${lastDeletion === undefined ? "" : ` until ${lastDeletion}`}. It is no longer in ` +
              "Alchemy's state; `alchemy unsafe nuke` retries generated names.",
          );
        }),
      ),
      // Also covers a ring that disappears while its contents are being listed.
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.retry({
        while: (error) => error._tag === "Stackit.KMS.KeyRingNotEmpty",
        schedule: Schedule.spaced("5 seconds"),
        times: 6,
      }),
    );

export const KeyRingProvider = () =>
  Provider.succeed(KeyRing, {
    // No update operation exists: only `state` can change on a live ring.
    stables: ["keyRingId", "projectId", "region", "displayName", "description", "createdAt"],
    // Nuke ordering: `Key` and `WrappingKey` declare
    // `dependsOn: ["Stackit.KMS.KeyRing"]`, so they go first.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const rings = yield* listGeneratedKeyRings(scope);
      return rings.map((ring) => toAttrs(scope, ring));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (
        hasUnresolvedTrigger<KeyRingProps>(news, [
          "displayName",
          "description",
          "projectId",
          "region",
        ])
      ) {
        // An explicit name can resolve to the current one: delete first. A
        // generated name changes with the new generation.
        return {
          action: "replace" as const,
          deleteFirst: rawProp<KeyRingProps>(news, "displayName") !== undefined,
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
      if (nameChanged || descriptionChanged || scopeChanged) {
        return {
          action: "replace" as const,
          deleteFirst: news.displayName !== undefined && !nameChanged && !scopeChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      // Tracked in state: ours, or gone.
      if (output !== undefined) {
        const ring = yield* getKeyRingOrUndefined(scope, output.keyRingId);
        return ring === undefined ? undefined : toAttrs(scope, ring);
      }
      const explicitName = olds?.displayName;
      const displayName = explicitName ?? (yield* generatedKmsName(id));
      // The generation being replaced keeps its name, and may even survive its
      // delete as a left-behind ring. It is never a candidate: garbage collection
      // deletes what `read` hands to a create-first replacement.
      const rings = yield* listLiveKeyRings(scope);
      const ring = rings.find(
        (candidate) =>
          candidate.displayName === displayName && candidate.id !== previous?.keyRingId,
      );
      if (ring === undefined) return undefined;
      const attrs = toAttrs(scope, ring);
      // A generated name carries this generation's instance id: a crashed create.
      return explicitName === undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const displayName = news.displayName ?? output?.displayName ?? (yield* generatedKmsName(id));

      // 1. Observe — the recorded id, while it still names this scope. A
      // generated name also finds a crashed create; an explicit name never
      // claims anything here, because `read` gates that behind `--adopt`.
      let ring: kms.KeyRing | undefined;
      if (output?.projectId === scope.projectId && output.region === scope.region) {
        ring = yield* getKeyRingOrUndefined(scope, output.keyRingId);
      }
      if (ring === undefined && news.displayName === undefined) {
        const rings = yield* listLiveKeyRings(scope);
        ring = rings.find((candidate) => candidate.displayName === displayName);
      }

      // 2. Ensure — there is nothing to sync: a key ring has no update operation.
      if (ring === undefined) {
        ring = yield* kms.createKeyRing({
          projectId: scope.projectId,
          regionId: scope.region,
          displayName,
          ...(news.description ? { description: news.description } : {}),
        });
      }
      const keyRingId = ring.id;
      if (ring.state !== "active") {
        ring = yield* waitFor({
          resource: `STACKIT KMS key ring ${keyRingId}`,
          read: kms.getKeyRing({
            projectId: scope.projectId,
            regionId: scope.region,
            keyRingId,
          }),
          ready: (observed) => observed.state === "active",
          failed: (observed) => observed.state === "deleted",
          state: (observed) => observed.state,
          timeout: KMS_TIMEOUT,
        });
      }

      // 3. Return
      return toAttrs(scope, ring);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const ring = yield* getKeyRingOrUndefined(scope, output.keyRingId);
      if (ring !== undefined) yield* deleteKeyRingOrLeaveBehind(scope, output);
    }),
  });
