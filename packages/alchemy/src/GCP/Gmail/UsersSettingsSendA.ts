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
  encodeOwnership,
  getSendAs,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listSendAs,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  sendAsOwnershipText,
  smtpPublicOf,
  toUserId,
} from "./internal.ts";

export type UsersSettingsSendASmtpMsa = {
  /** SMTP hostname. */
  host?: string;
  /** SMTP port. */
  port?: number;
  /** Security mode (`none`, `ssl`, or `starttls`). */
  securityMode?: gmail.SmtpMsaSecurityModeEnum | (string & {});
  /** SMTP username (write-only). */
  username?: string;
  /** SMTP password (write-only). */
  password?: string;
};

export type UsersSettingsSendAProps = {
  /**
   * Mailbox to manage. Email address or `"me"`.
   * @default "me"
   */
  userId?: string;
  /**
   * Address that appears in the `From` header. Identity — changing it
   * replaces the alias. Required.
   */
  sendAsEmail: string;
  /**
   * Display name in the `From` header.
   */
  displayName?: string;
  /**
   * HTML signature. Gmail send-as aliases have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  signature?: string;
  /** `Reply-To` address. */
  replyToAddress?: string;
  /**
   * Whether this alias is the default From address. The only writable
   * value is `true`.
   */
  isDefault?: boolean;
  /**
   * Treat this custom From as an alias of the primary address.
   */
  treatAsAlias?: boolean;
  /**
   * SMTP MSA used as an outbound relay for custom From aliases.
   */
  smtpMsa?: UsersSettingsSendASmtpMsa;
};

export type UsersSettingsSendA = Resource<
  "GCP.Gmail.UsersSettingsSendA",
  UsersSettingsSendAProps,
  {
    /** Send-as email address. */
    sendAsEmail: string;
    /** Mailbox the alias belongs to. */
    userId: string;
    /** Project id used when the alias was reconciled. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User signature with the Alchemy ownership prefix stripped. */
    signature: string | undefined;
    /** Reply-To address. */
    replyToAddress: string | undefined;
    /** Whether this is the primary login address. */
    isPrimary: boolean;
    /** Whether this is the default From address. */
    isDefault: boolean;
    /** Whether Gmail treats this as an alias of the primary address. */
    treatAsAlias: boolean;
    /** Verification status for custom aliases. */
    verificationStatus: string | undefined;
    /** SMTP MSA public fields (password never returned). */
    smtpMsa: UsersSettingsSendASmtpMsa | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail send-as alias ("Send mail as").
 *
 * Gmail send-as aliases have no labels field, so Alchemy stamps
 * ownership into `signature` for `list` / nuke. `sendAsEmail` is
 * identity. Display name, signature, reply-to, default flag, and SMTP
 * MSA update in place. The primary login address cannot be deleted.
 * Creating custom aliases requires domain-wide delegation.
 *
 * ### Creating a Send-As Alias
 * **Example:** Custom From with a signature
 * ```typescript
 * const alias = yield* GCP.Gmail.UsersSettingsSendA("Support", {
 *   sendAsEmail: "support@example.com",
 *   displayName: "Support",
 *   signature: "Thanks",
 *   treatAsAlias: true,
 * });
 * ```
 *
 * ### Updating a Signature
 * **Example:** Change the signature
 * ```typescript
 * const alias = yield* GCP.Gmail.UsersSettingsSendA("Support", {
 *   sendAsEmail: existing.sendAsEmail,
 *   displayName: "Support",
 *   signature: "Best",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersSettingsSendA = Resource<UsersSettingsSendA>(
  "GCP.Gmail.UsersSettingsSendA",
);

export class UsersSettingsSendANotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersSettingsSendANotResolved",
)<{
  userId: string;
  sendAsEmail: string;
}> {}

const smtpOf = (
  smtp: gmail.SmtpMsa | undefined,
): UsersSettingsSendASmtpMsa | undefined => smtpPublicOf(smtp);

const toAttrs = (alias: gmail.SendAs, userId: string, project: string) => ({
  sendAsEmail: alias.sendAsEmail ?? "",
  userId,
  project,
  displayName: alias.displayName,
  signature: parseOwnership(alias.signature).text,
  replyToAddress: alias.replyToAddress,
  isPrimary: alias.isPrimary === true,
  isDefault: alias.isDefault === true,
  treatAsAlias: alias.treatAsAlias === true,
  verificationStatus: alias.verificationStatus,
  smtpMsa: smtpOf(alias.smtpMsa),
});

export const UsersSettingsSendAProvider = () =>
  Provider.succeed(UsersSettingsSendA, {
    stables: ["sendAsEmail", "userId", "project", "isPrimary"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousEmail = olds?.sendAsEmail ?? output?.sendAsEmail;
      if (previousEmail !== undefined && news.sendAsEmail !== previousEmail) {
        return {
          action: "replace" as const,
          deleteFirst: output?.isPrimary !== true,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const sendAsEmail = olds?.sendAsEmail ?? output?.sendAsEmail ?? "";
      const existing = yield* getSendAs(userId, sendAsEmail);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return (yield* ownedByAlchemy(id, sendAsOwnershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const aliases = yield* listSendAs(DEFAULT_USER);
        return aliases
          .filter((alias) => hasOwnershipMarker(sendAsOwnershipText(alias)))
          .map((alias) => toAttrs(alias, DEFAULT_USER, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(news.userId, output?.userId);
      const sendAsEmail = news.sendAsEmail;
      const ownership = yield* ownershipLabels(id);
      const signature = encodeOwnership(ownership, news.signature);
      const desired: gmail.SendAs = {
        sendAsEmail,
        displayName: news.displayName,
        signature,
        replyToAddress: news.replyToAddress,
        isDefault: news.isDefault,
        treatAsAlias: news.treatAsAlias,
        smtpMsa: news.smtpMsa,
      };

      let current = yield* getSendAs(userId, sendAsEmail);

      if (current === undefined) {
        const created = yield* gmail
          .createUsersSettingsSendAs({ userId, body: desired })
          .pipe(
            Effect.catchTag("Conflict", () => getSendAs(userId, sendAsEmail)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersSettingsSendANotResolved({
          userId,
          sendAsEmail,
        });
      }

      const signatureChanged = !sameText(current.signature, signature);
      const displayChanged =
        news.displayName !== undefined &&
        !sameText(current.displayName, news.displayName);
      const replyChanged =
        news.replyToAddress !== undefined &&
        !sameText(current.replyToAddress, news.replyToAddress);
      const defaultChanged =
        news.isDefault === true && current.isDefault !== true;
      const aliasChanged =
        news.treatAsAlias !== undefined &&
        current.treatAsAlias !== news.treatAsAlias;
      const smtpChanged =
        news.smtpMsa !== undefined &&
        !jsonEqual(smtpPublicOf(current.smtpMsa), smtpPublicOf(news.smtpMsa));

      if (
        signatureChanged ||
        displayChanged ||
        replyChanged ||
        defaultChanged ||
        aliasChanged ||
        smtpChanged
      ) {
        current = yield* gmail.patchUsersSettingsSendAs({
          userId,
          sendAsEmail,
          body: desired,
        });
      }

      return toAttrs(current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.sendAsEmail.length === 0) return;
      if (output.isPrimary) return;
      yield* ignoreMissing(
        gmail.deleteUsersSettingsSendAs({
          userId: output.userId || DEFAULT_USER,
          sendAsEmail: output.sendAsEmail,
        }),
      );
    }),
  });
