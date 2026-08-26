import * as gmail from "@distilled.cloud/gcp/gmail_v1";
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
  getCseIdentity,
  ignoreMissing,
  isAlchemyEmail,
  jsonEqual,
  listCseIdentities,
  sameText,
  toUserId,
} from "./internal.ts";

export type UsersSettingsCseIdentityKeyPairs = {
  /** CseKeyPair id used to sign outgoing mail. */
  signingKeyPairId?: string;
  /** CseKeyPair id used to encrypt signed outgoing mail. */
  encryptionKeyPairId?: string;
};

export type UsersSettingsCseIdentityProps = {
  /**
   * Mailbox to manage. Email address or `"me"`.
   * @default "me"
   */
  userId?: string;
  /**
   * Email address for the sending identity. Must be the primary email
   * of the authenticated user. Identity — changing it replaces the CSE
   * identity.
   */
  emailAddress: string;
  /**
   * CseKeyPair id associated with this identity.
   */
  primaryKeyPairId?: string;
  /**
   * Signing and encryption key pair configuration.
   */
  signAndEncryptKeyPairs?: UsersSettingsCseIdentityKeyPairs;
};

export type UsersSettingsCseIdentity = Resource<
  "GCP.Gmail.UsersSettingsCseIdentity",
  UsersSettingsCseIdentityProps,
  {
    /** CSE identity email. */
    emailAddress: string;
    /** Mailbox the identity belongs to. */
    userId: string;
    /** Project id used when the identity was reconciled. */
    project: string;
    /** Primary key pair id. */
    primaryKeyPairId: string | undefined;
    /** Signing and encryption key pair ids. */
    signAndEncryptKeyPairs: UsersSettingsCseIdentityKeyPairs | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail client-side encryption (CSE) identity.
 *
 * CSE identities have no labels or description, so identity is
 * `(userId, emailAddress)` and `list` / nuke returns identities for
 * the authenticated mailbox (typically one, the primary address). Key
 * pair ids update in place. Create requires domain-wide delegation or
 * hardware key encryption.
 *
 * ### Creating a CSE Identity
 * **Example:** Bind a key pair
 * ```typescript
 * const identity = yield* GCP.Gmail.UsersSettingsCseIdentity("Primary", {
 *   emailAddress: "ada@example.com",
 *   primaryKeyPairId: "kp-1",
 * });
 * ```
 *
 * ### Updating Key Pairs
 * **Example:** Rotate the key pair
 * ```typescript
 * const identity = yield* GCP.Gmail.UsersSettingsCseIdentity("Primary", {
 *   emailAddress: existing.emailAddress,
 *   primaryKeyPairId: "kp-2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersSettingsCseIdentity = Resource<UsersSettingsCseIdentity>(
  "GCP.Gmail.UsersSettingsCseIdentity",
);

export class UsersSettingsCseIdentityNotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersSettingsCseIdentityNotResolved",
)<{
  userId: string;
  emailAddress: string;
}> {}

const pairsOf = (
  pairs: gmail.SignAndEncryptKeyPairs | undefined,
): UsersSettingsCseIdentityKeyPairs | undefined => {
  if (pairs === undefined) return undefined;
  return {
    signingKeyPairId: pairs.signingKeyPairId,
    encryptionKeyPairId: pairs.encryptionKeyPairId,
  };
};

const toAttrs = (
  identity: gmail.CseIdentity,
  userId: string,
  project: string,
) => ({
  emailAddress: identity.emailAddress ?? "",
  userId,
  project,
  primaryKeyPairId: identity.primaryKeyPairId,
  signAndEncryptKeyPairs: pairsOf(identity.signAndEncryptKeyPairs),
});

export const UsersSettingsCseIdentityProvider = () =>
  Provider.succeed(UsersSettingsCseIdentity, {
    stables: ["emailAddress", "userId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousEmail = olds?.emailAddress ?? output?.emailAddress;
      if (previousEmail !== undefined && news.emailAddress !== previousEmail) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const emailAddress = olds?.emailAddress ?? output?.emailAddress ?? "";
      const existing = yield* getCseIdentity(userId, emailAddress);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const identities = yield* listCseIdentities(DEFAULT_USER);
        return identities
          .filter((identity) => isAlchemyEmail(identity.emailAddress))
          .map((identity) => toAttrs(identity, DEFAULT_USER, env.project));
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(news.userId, output?.userId);
      const emailAddress = news.emailAddress;
      const desired: gmail.CseIdentity = {
        emailAddress,
        primaryKeyPairId: news.primaryKeyPairId,
        signAndEncryptKeyPairs: news.signAndEncryptKeyPairs,
      };

      let current = yield* getCseIdentity(userId, emailAddress);

      if (current === undefined) {
        const created = yield* gmail
          .createUsersSettingsCseIdentities({ userId, body: desired })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getCseIdentity(userId, emailAddress),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersSettingsCseIdentityNotResolved({
          userId,
          emailAddress,
        });
      }

      const keyChanged =
        news.primaryKeyPairId !== undefined &&
        !sameText(current.primaryKeyPairId, news.primaryKeyPairId);
      const pairsChanged =
        news.signAndEncryptKeyPairs !== undefined &&
        !jsonEqual(
          pairsOf(current.signAndEncryptKeyPairs),
          news.signAndEncryptKeyPairs,
        );

      if (keyChanged || pairsChanged) {
        current = yield* gmail.patchUsersSettingsCseIdentities({
          userId,
          emailAddress,
          body: desired,
        });
      }

      return toAttrs(current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.emailAddress.length === 0) return;
      yield* ignoreMissing(
        gmail.deleteUsersSettingsCseIdentities({
          userId: output.userId || DEFAULT_USER,
          cseEmailAddress: output.emailAddress,
        }),
      );
    }),
  });
