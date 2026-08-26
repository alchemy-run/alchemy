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
  findSmime,
  findSmimeAfterConflict,
  hasOwnershipMarker,
  listSendAs,
  listSmime,
  sameText,
} from "./internal.ts";

export type UsersSettingsSendAsSmimeInfoProps = {
  /**
   * Gmail user id. The special value `"me"` is the authenticated user.
   * Immutable — changing it replaces the S/MIME config.
   * @default "me"
   */
  userId?: string;
  /**
   * Send-as alias the certificate is attached to (the address in the
   * `From:` header). Immutable — changing it replaces the S/MIME config.
   */
  sendAsEmail: string;
  /**
   * Gmail-assigned S/MIME config id. Server-assigned from the
   * certificate on create. Immutable — changing it replaces the config.
   */
  smimeInfoId?: string;
  /**
   * PKCS#12 containing a single private/public key pair and certificate
   * chain, base64-encoded. Required on create; never returned by Gmail.
   * Changing it replaces the config. S/MIME configs have no labels
   * field, so Alchemy ownership is recognized from an issuer CN that
   * contains `alchemy-` (stamp this in the certificate you upload).
   */
  pkcs12?: string;
  /**
   * Password for the PKCS#12 private key when the key is encrypted.
   */
  encryptedKeyPassword?: string;
  /**
   * When true, this config is the default S/MIME certificate for the
   * send-as alias. Gmail only accepts `true` — set another config as
   * default to clear this one.
   * @default false
   */
  isDefault?: boolean;
};

export type UsersSettingsSendAsSmimeInfo = Resource<
  "GCP.Gmail.UsersSettingsSendAsSmimeInfo",
  UsersSettingsSendAsSmimeInfoProps,
  {
    /** Gmail-assigned S/MIME config id. */
    smimeInfoId: string;
    /** Gmail user id used to manage the config. */
    userId: string;
    /** Send-as alias the certificate is attached to. */
    sendAsEmail: string;
    /** Whether this config is the default for the send-as alias. */
    isDefault: boolean;
    /** Certificate expiry in milliseconds since epoch. */
    expiration: string | undefined;
    /** Issuer common name of the uploaded certificate. */
    issuerCn: string | undefined;
    /** PEM-encoded certificate chain (no private key). */
    pem: string | undefined;
    /** Project id used when the config was reconciled. */
    project: string;
  },
  never,
  Providers
>;

/**
 * An S/MIME certificate on a Gmail send-as alias.
 *
 * Gmail S/MIME configs have no labels or description field. Identity is
 * the server-assigned id (derived from the certificate). `userId`,
 * `sendAsEmail`, and `pkcs12` are immutable — changing them replaces
 * the config. `isDefault` updates in place via `smimeInfo.setDefault`.
 * `list` / nuke keep configs whose issuer CN contains `alchemy-`.
 *
 * ### Creating an S/MIME Config
 * **Example:** Upload a PKCS#12 for a send-as alias
 * ```typescript
 * const smime = yield* GCP.Gmail.UsersSettingsSendAsSmimeInfo("Work", {
 *   sendAsEmail: "ada@example.com",
 *   pkcs12: pkcs12Base64,
 *   encryptedKeyPassword: "secret",
 * });
 * ```
 *
 * **Example:** Make the certificate the default for the alias
 * ```typescript
 * const smime = yield* GCP.Gmail.UsersSettingsSendAsSmimeInfo("Work", {
 *   sendAsEmail: "ada@example.com",
 *   pkcs12: pkcs12Base64,
 *   encryptedKeyPassword: "secret",
 *   isDefault: true,
 * });
 * ```
 *
 * ### Updating an S/MIME Config
 * **Example:** Set the uploaded certificate as default
 * ```typescript
 * const smime = yield* GCP.Gmail.UsersSettingsSendAsSmimeInfo("Work", {
 *   sendAsEmail: existing.sendAsEmail,
 *   smimeInfoId: existing.smimeInfoId,
 *   isDefault: true,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersSettingsSendAsSmimeInfo =
  Resource<UsersSettingsSendAsSmimeInfo>(
    "GCP.Gmail.UsersSettingsSendAsSmimeInfo",
  );

export class UsersSettingsSendAsSmimeInfoNotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersSettingsSendAsSmimeInfoNotResolved",
)<{
  userId: string;
  sendAsEmail: string;
}> {}

const toAttrs = (
  info: gmail.SmimeInfo,
  userId: string,
  sendAsEmail: string,
  project: string,
) => ({
  smimeInfoId: info.id ?? "",
  userId,
  sendAsEmail,
  isDefault: info.isDefault === true,
  expiration: info.expiration,
  issuerCn: info.issuerCn,
  pem: info.pem,
  project,
});

const isOwned = (info: gmail.SmimeInfo, outputId: string | undefined) =>
  hasOwnershipMarker(info.issuerCn) ||
  (outputId !== undefined && sameText(info.id, outputId));

export const UsersSettingsSendAsSmimeInfoProvider = () =>
  Provider.succeed(UsersSettingsSendAsSmimeInfo, {
    stables: [
      "smimeInfoId",
      "userId",
      "sendAsEmail",
      "project",
      "expiration",
      "issuerCn",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (news.userId !== undefined && nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousAlias = olds?.sendAsEmail ?? output?.sendAsEmail;
      if (previousAlias !== undefined && news.sendAsEmail !== previousAlias) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.smimeInfoId ?? output?.smimeInfoId;
      if (
        previousId !== undefined &&
        news.smimeInfoId !== undefined &&
        news.smimeInfoId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      if (
        olds?.pkcs12 !== undefined &&
        news.pkcs12 !== undefined &&
        news.pkcs12 !== olds.pkcs12
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const sendAsEmail = olds?.sendAsEmail ?? output?.sendAsEmail;
      if (sendAsEmail === undefined) return undefined;
      const smimeInfoId = olds?.smimeInfoId ?? output?.smimeInfoId ?? "";
      const existing = yield* findSmime(userId, sendAsEmail, smimeInfoId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, sendAsEmail, env.project);
      return isOwned(existing, output?.smimeInfoId) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const userId = DEFAULT_USER;
        const aliases = yield* listSendAs(userId);
        const pages = yield* Effect.forEach(
          aliases,
          (alias) =>
            alias.sendAsEmail
              ? listSmime(userId, alias.sendAsEmail).pipe(
                  Effect.map((infos) =>
                    infos
                      .filter((info) => hasOwnershipMarker(info.issuerCn))
                      .map((info) =>
                        toAttrs(
                          info,
                          userId,
                          alias.sendAsEmail ?? "",
                          env.project,
                        ),
                      ),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = news.userId ?? output?.userId ?? DEFAULT_USER;
      const sendAsEmail = news.sendAsEmail;
      const smimeInfoId = news.smimeInfoId ?? output?.smimeInfoId ?? "";

      let current = yield* findSmime(userId, sendAsEmail, smimeInfoId);

      if (current === undefined && news.pkcs12) {
        const created = yield* gmail
          .insertUsersSettingsSendAsSmimeInfo({
            userId,
            sendAsEmail,
            body: {
              pkcs12: news.pkcs12,
              encryptedKeyPassword: news.encryptedKeyPassword,
              isDefault: news.isDefault === true ? true : undefined,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findSmimeAfterConflict(userId, sendAsEmail),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersSettingsSendAsSmimeInfoNotResolved({
          userId,
          sendAsEmail,
        });
      }

      const id = current.id ?? smimeInfoId;
      if (
        news.isDefault === true &&
        current.isDefault !== true &&
        id.length > 0
      ) {
        yield* gmail.setDefaultUsersSettingsSendAsSmimeInfo({
          userId,
          sendAsEmail,
          id,
        });
        current = (yield* findSmime(userId, sendAsEmail, id)) ?? current;
      }

      return toAttrs(current, userId, sendAsEmail, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.smimeInfoId.length === 0) return;
      yield* gmail
        .deleteUsersSettingsSendAsSmimeInfo({
          userId: output.userId,
          sendAsEmail: output.sendAsEmail,
          id: output.smimeInfoId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
