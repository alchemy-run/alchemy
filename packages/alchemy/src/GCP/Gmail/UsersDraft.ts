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
  encodeOwnershipLine,
  findOwnedDraft,
  getDraft,
  ignoreMissing,
  listOwnedDrafts,
  messageBody,
  messageHeader,
  messageSubject,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameStringList,
  sameText,
  stampRawMessage,
  toUserId,
} from "./internal.ts";

export type UsersDraftProps = {
  /**
   * Mailbox to manage. Email address or `"me"`.
   * @default "me"
   */
  userId?: string;
  /**
   * Gmail-assigned draft id. Server-assigned on create. Immutable —
   * changing it replaces the draft.
   */
  draftId?: string;
  /**
   * Thread to append this draft to. Immutable — changing it replaces
   * the draft.
   */
  threadId?: string;
  /**
   * Subject. Gmail drafts have no labels field, so Alchemy ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
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
  /** Label ids applied to the draft message. */
  labelIds?: string[];
};

export type UsersDraft = Resource<
  "GCP.Gmail.UsersDraft",
  UsersDraftProps,
  {
    /** Gmail-assigned draft id. */
    draftId: string;
    /** Mailbox the draft belongs to. */
    userId: string;
    /** Project id used when the draft was reconciled. */
    project: string;
    /** Underlying message id, when returned. */
    messageId: string | undefined;
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
    /** Label ids on the draft message. */
    labelIds: string[];
    /** Snippet. */
    snippet: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail draft in the user's mailbox.
 *
 * Gmail drafts have no labels field, so Alchemy stamps ownership into
 * the `Subject` header for `list` / nuke. Mailbox and draft id are
 * identity. Subject, recipients, and body update in place via
 * `drafts.update`.
 *
 * ### Creating a Draft
 * **Example:** Generated subject
 * ```typescript
 * const draft = yield* GCP.Gmail.UsersDraft("FollowUp", {
 *   to: "ada@example.com",
 *   body: "circling back",
 * });
 * ```
 *
 * **Example:** Explicit subject
 * ```typescript
 * const draft = yield* GCP.Gmail.UsersDraft("FollowUp", {
 *   subject: "Q2 follow-up",
 *   to: "ada@example.com",
 *   body: "circling back",
 * });
 * ```
 *
 * ### Updating a Draft
 * **Example:** Change the body
 * ```typescript
 * const draft = yield* GCP.Gmail.UsersDraft("FollowUp", {
 *   draftId: existing.draftId,
 *   subject: "Q2 follow-up",
 *   to: "ada@example.com",
 *   body: "updated notes",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersDraft = Resource<UsersDraft>("GCP.Gmail.UsersDraft");

export class UsersDraftNotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersDraftNotResolved",
)<{
  userId: string;
  draftId: string;
}> {}

const toAttrs = (draft: gmail.Draft, userId: string, project: string) => ({
  draftId: draft.id ?? "",
  userId,
  project,
  messageId: draft.message?.id,
  threadId: draft.message?.threadId,
  subject: parseOwnership(messageSubject(draft.message)).text,
  from: messageHeader(draft.message, "From"),
  to: messageHeader(draft.message, "To"),
  cc: messageHeader(draft.message, "Cc"),
  bcc: messageHeader(draft.message, "Bcc"),
  body: messageBody(draft.message),
  labelIds: draft.message?.labelIds ?? [],
  snippet: draft.message?.snippet,
});

const draftBody = (
  raw: string,
  threadId: string | undefined,
  labelIds: string[] | undefined,
): gmail.Draft => ({
  message: {
    raw,
    threadId,
    labelIds,
  },
});

export const UsersDraftProvider = () =>
  Provider.succeed(UsersDraft, {
    stables: ["draftId", "userId", "project", "messageId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.draftId ?? output?.draftId;
      if (
        previousId !== undefined &&
        news.draftId !== undefined &&
        news.draftId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousThread = olds?.threadId ?? output?.threadId;
      if (
        news.threadId !== undefined &&
        previousThread !== undefined &&
        news.threadId !== previousThread
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const draftId = olds?.draftId ?? output?.draftId ?? "";
      let existing = yield* getDraft(userId, draftId);
      if (existing === undefined) {
        existing = yield* findOwnedDraft(userId, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return (yield* ownedByAlchemy(id, messageSubject(existing.message)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const drafts = yield* listOwnedDrafts(DEFAULT_USER);
        return drafts.map((draft) => toAttrs(draft, DEFAULT_USER, env.project));
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
      const threadId = news.threadId ?? output?.threadId;
      const desired = draftBody(raw, threadId, news.labelIds);

      let current = yield* getDraft(
        userId,
        news.draftId ?? output?.draftId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedDraft(userId, id);
      }

      if (current === undefined) {
        const created = yield* gmail
          .createUsersDrafts({ userId, body: desired })
          .pipe(Effect.catchTag("Conflict", () => findOwnedDraft(userId, id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersDraftNotResolved({
          userId,
          draftId: news.draftId ?? output?.draftId ?? "",
        });
      }

      const draftId = current.id ?? news.draftId ?? output?.draftId ?? "";
      const desiredSubject = encodeOwnershipLine(
        ownership,
        news.subject ?? output?.subject,
      );
      const subjectChanged = !sameText(
        messageSubject(current.message),
        desiredSubject,
      );
      const bodyChanged =
        news.body !== undefined &&
        !sameText(messageBody(current.message), news.body);
      const toChanged =
        news.to !== undefined &&
        !sameText(messageHeader(current.message, "To"), news.to);
      const fromChanged =
        news.from !== undefined &&
        !sameText(messageHeader(current.message, "From"), news.from);
      const labelsChanged =
        news.labelIds !== undefined &&
        !sameStringList(current.message?.labelIds, news.labelIds);

      if (
        subjectChanged ||
        bodyChanged ||
        toChanged ||
        fromChanged ||
        labelsChanged
      ) {
        current = yield* gmail
          .updateUsersDrafts({
            userId,
            id: draftId,
            body: { ...desired, id: draftId },
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              gmail.createUsersDrafts({ userId, body: desired }),
            ),
          );
      }

      const fresh = yield* getDraft(userId, current.id ?? draftId);
      return toAttrs(fresh ?? current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.draftId.length === 0) return;
      yield* ignoreMissing(
        gmail.deleteUsersDrafts({
          userId: output.userId || DEFAULT_USER,
          id: output.draftId,
        }),
      );
    }),
  });
