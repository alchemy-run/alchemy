import * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_USER,
  findOwnedKey,
  fingerprintOf,
  hasOwnershipMarker,
  ignoreMissing,
  keyComment,
  listOwnedKeys,
  ownedByAlchemy,
  ownershipLabels,
  parseSshKey,
  resolveUser,
  resourceName,
  retryConflict,
  sameKeyMaterial,
  stampKey,
  toGeneratedName,
  toUserId,
  toUserParent,
  unstampKey,
  userOf,
} from "./internal.ts";

export type UsersSshPublicKeyProps = {
  /**
   * Google account that owns the key. Email, `"me"`, or
   * `users/{user}`. Immutable — changing it replaces the key.
   * @default "me"
   */
  user?: string;
  /**
   * Public key text in SSH format (RFC4253). Changing the key material
   * (type or blob) replaces the resource; the comment is stamped with
   * Alchemy ownership and can update in place.
   */
  key: string;
  /**
   * Expiration time in microseconds since epoch. Omit for no expiry.
   */
  expirationTimeUsec?: string;
};

export type UsersSshPublicKey = Resource<
  "GCP.Oslogin.UsersSshPublicKey",
  UsersSshPublicKeyProps,
  {
    /** Canonical name `users/{user}/sshPublicKeys/{fingerprint}`. */
    name: string;
    /** User id used when the key was reconciled (`me` or email). */
    user: string;
    /** SHA-256 fingerprint of the SSH public key. */
    fingerprint: string;
    /** User-facing SSH public key with the Alchemy ownership prefix stripped. */
    key: string;
    /** Expiration time in microseconds since epoch, if set. */
    expirationTimeUsec: string | undefined;
    /** Project id used when the key was reconciled. */
    project: string;
  },
  never,
  Providers
>;

/**
 * An OS Login SSH public key on a Google account.
 *
 * SSH public keys have no labels field, so Alchemy stamps ownership
 * into the key comment (`[alchemy …]`) for `list` / nuke. `user` and
 * key material are identity — changing either replaces the key.
 * Expiration updates in place. `"me"` is resolved to the authenticated
 * identity (a user email, or a service account email — `users/me` is
 * rejected for service accounts).
 *
 * ### Creating a Key
 * **Example:** Current user
 * ```typescript
 * const sshKey = yield* GCP.Oslogin.UsersSshPublicKey("Laptop", {
 *   key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... laptop",
 * });
 * ```
 *
 * **Example:** With expiration
 * ```typescript
 * const sshKey = yield* GCP.Oslogin.UsersSshPublicKey("Laptop", {
 *   user: "me",
 *   key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... laptop",
 *   expirationTimeUsec: "4102444800000000",
 * });
 * ```
 *
 * ### Updating a Key
 * **Example:** Extend expiration
 * ```typescript
 * const sshKey = yield* GCP.Oslogin.UsersSshPublicKey("Laptop", {
 *   key: existing.key,
 *   expirationTimeUsec: "4133980800000000",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Oslogin
 */
export const UsersSshPublicKey = Resource<UsersSshPublicKey>(
  "GCP.Oslogin.UsersSshPublicKey",
);

export class UsersSshPublicKeyNotResolved extends Data.TaggedError(
  "GCP.Oslogin.UsersSshPublicKeyNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (key: oslogin.SshPublicKey, user: string, project: string) => {
  const name = key.name ?? "";
  return {
    name,
    user,
    fingerprint: key.fingerprint ?? fingerprintOf(name),
    key: unstampKey(key.key),
    expirationTimeUsec: key.expirationTimeUsec,
    project,
  };
};

const ownershipText = (key: oslogin.SshPublicKey | undefined) =>
  parseSshKey(key?.key).comment ?? key?.key;

export const UsersSshPublicKeyProvider = () =>
  Provider.succeed(UsersSshPublicKey, {
    stables: ["name", "user", "fingerprint", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.user ?? output?.user ?? DEFAULT_USER;
      const nextUser = toUserId(news.user, news.user);
      const oldUser = toUserId(previousUser, previousUser);
      if (
        news.user !== undefined &&
        nextUser !== oldUser &&
        nextUser !== DEFAULT_USER &&
        oldUser !== DEFAULT_USER
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousKey = olds?.key ?? output?.key;
      if (
        previousKey !== undefined &&
        news.key !== undefined &&
        !sameKeyMaterial(news.key, previousKey)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const user = yield* resolveUser(toUserId(olds?.user, output?.user));
      const existing = yield* findOwnedKey(user, id, {
        name: output?.name,
        fingerprint: output?.fingerprint,
        key: olds?.key ?? output?.key,
        project: env.project,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, user, env.project);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const user = yield* resolveUser(DEFAULT_USER);
        const items = yield* listOwnedKeys(user, env.project);
        return items
          .filter(
            (item) =>
              hasOwnershipMarker(item.key) ||
              hasOwnershipMarker(parseSshKey(item.key).comment),
          )
          .map((item) =>
            toAttrs(item, userOf(item.name, DEFAULT_USER), env.project),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const user = yield* resolveUser(toUserId(news.user, output?.user));
      const labels = yield* ownershipLabels(id);
      const displayComment = yield* toGeneratedName(
        id,
        keyComment(news.key),
        keyComment(output?.key),
      );
      const desiredKey = stampKey(news.key, labels, displayComment);

      let current = yield* findOwnedKey(user, id, {
        name: output?.name,
        fingerprint: output?.fingerprint,
        key: desiredKey,
        project: env.project,
      });

      if (current === undefined) {
        const created = yield* retryConflict(
          oslogin.createUsersSshPublicKeys({
            parent: toUserParent(user),
            body: {
              key: desiredKey,
              expirationTimeUsec: news.expirationTimeUsec,
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () =>
            findOwnedKey(user, id, {
              key: desiredKey,
              project: env.project,
            }),
          ),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersSshPublicKeyNotResolved({
          name: output?.name ?? resourceName(user, output?.fingerprint ?? ""),
        });
      }

      const name =
        current.name ??
        resourceName(user, current.fingerprint ?? output?.fingerprint ?? "");
      // Fingerprint is SHA-256 of the full key text including the comment,
      // so never patch `key` — comment/ownership is create-only.
      const expirationChanged =
        (current.expirationTimeUsec ?? "") !== (news.expirationTimeUsec ?? "");

      if (expirationChanged) {
        current = yield* retryConflict(
          oslogin.patchUsersSshPublicKeys({
            name,
            updateMask: "expirationTimeUsec",
            body: {
              expirationTimeUsec: news.expirationTimeUsec,
            },
          }),
        );
      }

      return toAttrs(current, user, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name =
        output.name ||
        (output.fingerprint
          ? resourceName(output.user || DEFAULT_USER, output.fingerprint)
          : "");
      if (name.length === 0) return;
      yield* ignoreMissing(
        retryConflict(oslogin.deleteUsersSshPublicKeys({ name })),
      );
    }),
  });
