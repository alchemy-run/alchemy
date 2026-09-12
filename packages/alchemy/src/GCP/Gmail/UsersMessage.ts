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
  findOwnedMessage,
  getMessage,
  ignoreMissing,
  listOwnedMessages,
  messageBody,
  messageHeader,
  messageSubject,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  stampRawMessage,
  toUserId,
} from "./internal.ts";

export type UsersMessageProps = {
  /**
   * Mailbox to manage. Email address or `"me"`.
   * @default "me"
   */
  userId?: string;
  /**
   * Gmail-assigned message id. Server-assigned on insert. Immutable —
   * changing it replaces the message.
   */
  messageId?: string;
  /**
   * Thread to append this message to. Immutable — changing it replaces
   * the message.
   */
  threadId?: string;
  /**
   * Subject. Gmail messages have no labels field, so Alchemy ownership
   * is stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  subject?: string;
  /** `From` header. */
  from?: string;
  /** `To` header. */
  to?: string;
  /** `Cc` header. */
  cc?: string;
  /** `Bcc` header. */
  bcc?: string;
  /** Plain-text body. */
  body?: string;
  /**
   * Entire RFC 2822 message as a base64url string. When set, Alchemy
   * still stamps the `Subject` header with an ownership marker.
   */
  raw?: string;
  /**
   * Label ids on the message. Gmail may add system labels (`INBOX`,
   * `UNREAD`) on insert; omitting this field leaves observed labels
   * unchanged.
   */
  labelIds?: string[];
  /**
   * Source for Gmail's internal date (`receivedTime` or `dateHeader`).
   */
  internalDateSource?:
    | gmail.InsertUsersMessagesInternalDateSourceEnum
    | (string & {});
  /**
   * Mark the message as permanently deleted (Vault-only). Workspace
   * accounts only.
   */
  deleted?: boolean;
};

export type UsersMessage = Resource<
  "GCP.Gmail.UsersMessage",
  UsersMessageProps,
  {
    /** Gmail-assigned message id. */
    messageId: string;
    /** Mailbox the message belongs to. */
    userId: string;
    /** Project id used when the message was reconciled. */
    project: string;
    /** Thread id. */
    threadId: string | undefined;
    /** Subject with the Alchemy ownership prefix stripped. */
    subject: string | undefined;
    /** `From` header. */
    from: string | undefined;
    /** `To` header. */
    to: string | undefined;
    /** `Cc` header. */
    cc: string | undefined;
    /** `Bcc` header. */
    bcc: string | undefined;
    /** Plain-text body, when parsed. */
    body: string | undefined;
    /** Label ids. */
    labelIds: string[];
    /** Snippet. */
    snippet: string | undefined;
    /** History id. */
    historyId: string | undefined;
    /** Internal date (epoch ms). */
    internalDate: string | undefined;
    /** Estimated size in bytes. */
    sizeEstimate: number | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail message inserted into the user's mailbox.
 *
 * Gmail messages have no labels field, so Alchemy stamps ownership into
 * the `Subject` header for `list` / nuke. Mailbox, thread, and message
 * id are identity. Subject, recipients, and body are immutable —
 * changing them replaces the message (delete-first). Label ids sync in
 * place via `messages.modify`.
 *
 * ### Creating a Message
 * **Example:** Insert a note
 * ```typescript
 * const message = yield* GCP.Gmail.UsersMessage("Note", {
 *   subject: "runbook",
 *   body: "keep this",
 * });
 * ```
 *
 * **Example:** Insert with labels
 * ```typescript
 * const message = yield* GCP.Gmail.UsersMessage("Note", {
 *   subject: "runbook",
 *   body: "keep this",
 *   labelIds: ["INBOX"],
 * });
 * ```
 *
 * ### Updating Labels
 * **Example:** Star the message
 * ```typescript
 * const message = yield* GCP.Gmail.UsersMessage("Note", {
 *   messageId: existing.messageId,
 *   subject: "runbook",
 *   body: "keep this",
 *   labelIds: ["INBOX", "STARRED"],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersMessage = Resource<UsersMessage>("GCP.Gmail.UsersMessage");

export class UsersMessageNotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersMessageNotResolved",
)<{
  userId: string;
  messageId: string;
}> {}

const toAttrs = (message: gmail.Message, userId: string, project: string) => ({
  messageId: message.id ?? "",
  userId,
  project,
  threadId: message.threadId,
  subject: parseOwnership(messageSubject(message)).text,
  from: messageHeader(message, "From"),
  to: messageHeader(message, "To"),
  cc: messageHeader(message, "Cc"),
  bcc: messageHeader(message, "Bcc"),
  body: messageBody(message),
  labelIds: message.labelIds ?? [],
  snippet: message.snippet,
  historyId: message.historyId,
  internalDate: message.internalDate,
  sizeEstimate: message.sizeEstimate,
});

export const UsersMessageProvider = () =>
  Provider.succeed(UsersMessage, {
    stables: ["messageId", "userId", "project", "threadId", "historyId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.messageId ?? output?.messageId;
      if (
        previousId !== undefined &&
        news.messageId !== undefined &&
        news.messageId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousThread = olds?.threadId ?? output?.threadId;
      if (
        news.threadId !== undefined &&
        previousThread !== undefined &&
        news.threadId !== previousThread
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousSubject = olds?.subject ?? output?.subject;
      if (
        news.subject !== undefined &&
        previousSubject !== undefined &&
        news.subject !== previousSubject
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousBody = olds?.body ?? output?.body;
      if (
        news.body !== undefined &&
        previousBody !== undefined &&
        news.body !== previousBody
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousRaw = olds?.raw;
      if (
        news.raw !== undefined &&
        previousRaw !== undefined &&
        news.raw !== previousRaw
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const messageId = olds?.messageId ?? output?.messageId ?? "";
      let existing = yield* getMessage(userId, messageId);
      if (existing === undefined) {
        existing = yield* findOwnedMessage(userId, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return (yield* ownedByAlchemy(id, messageSubject(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const messages = yield* listOwnedMessages(DEFAULT_USER);
        return messages.map((message) =>
          toAttrs(message, DEFAULT_USER, env.project),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(news.userId, output?.userId);
      const ownership = yield* ownershipLabels(id);
      const raw = yield* stampRawMessage({
        labels: ownership,
        subject: news.subject ?? output?.subject,
        from: news.from,
        to: news.to,
        cc: news.cc,
        bcc: news.bcc,
        body: news.body,
        raw: news.raw,
      });

      let current = yield* getMessage(
        userId,
        news.messageId ?? output?.messageId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedMessage(userId, id);
      }

      if (current === undefined) {
        const created = yield* gmail
          .insertUsersMessages({
            userId,
            internalDateSource: news.internalDateSource,
            deleted: news.deleted,
            body: {
              raw,
              threadId: news.threadId,
              labelIds: news.labelIds,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedMessage(userId, id)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersMessageNotResolved({
          userId,
          messageId: news.messageId ?? output?.messageId ?? "",
        });
      }

      const messageId = current.id ?? news.messageId ?? output?.messageId ?? "";
      if (news.labelIds !== undefined) {
        const observed = new Set(current.labelIds ?? []);
        const desired = new Set(news.labelIds);
        const addLabelIds = [...desired].filter(
          (label) => !observed.has(label),
        );
        const removeLabelIds = [...observed].filter(
          (label) => !desired.has(label),
        );
        if (addLabelIds.length > 0 || removeLabelIds.length > 0) {
          current = yield* gmail.modifyUsersMessages({
            userId,
            id: messageId,
            body: { addLabelIds, removeLabelIds },
          });
        }
      }

      const fresh = yield* getMessage(userId, current.id ?? messageId);
      return toAttrs(fresh ?? current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.messageId.length === 0) return;
      yield* ignoreMissing(
        gmail.deleteUsersMessages({
          userId: output.userId || DEFAULT_USER,
          id: output.messageId,
        }),
      );
    }),
  });
