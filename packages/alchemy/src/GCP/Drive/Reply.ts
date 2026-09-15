import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwnedReply,
  getReply,
  hasOwnershipMarker,
  ignoreMissing,
  listOwnedReplies,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
} from "./internal.ts";

export type ReplyProps = {
  /**
   * Parent file id. Immutable — changing it replaces the reply.
   */
  fileId: string;
  /**
   * Parent comment id. Immutable — changing it replaces the reply.
   */
  commentId: string;
  /**
   * Drive-assigned reply id. Server-assigned on create. Immutable —
   * changing it replaces the reply.
   */
  replyId?: string;
  /**
   * Plain-text content. Drive replies have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes. Required on create unless `action` is set.
   */
  content?: string;
  /**
   * Action applied to the parent comment (`resolve` or `reopen`).
   * Create-only.
   */
  action?: string;
};

export type Reply = Resource<
  "GCP.Drive.Reply",
  ReplyProps,
  {
    /** Drive-assigned reply id. */
    replyId: string;
    /** Parent file id. */
    fileId: string;
    /** Parent comment id. */
    commentId: string;
    /** Project id used when the reply was reconciled. */
    project: string;
    /** User content with the Alchemy ownership prefix stripped. */
    content: string | undefined;
    /** HTML content. */
    htmlContent: string | undefined;
    /** Action applied to the parent comment. */
    action: string | undefined;
    /** Whether the reply is deleted. */
    deleted: boolean;
    /** RFC3339 creation timestamp. */
    createdTime: string | undefined;
    /** RFC3339 last-modified timestamp. */
    modifiedTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A reply to a comment on a Google Drive file.
 *
 * Alchemy stamps ownership into `content` for `list` / nuke. Parent
 * file, comment, and reply id are identity. Content updates in place.
 * `action` is create-only.
 *
 * ### Creating a Reply
 * **Example:** Reply to a comment
 * ```typescript
 * const reply = yield* GCP.Drive.Reply("Ack", {
 *   fileId: file.fileId,
 *   commentId: comment.commentId,
 *   content: "will fix",
 * });
 * ```
 *
 * ### Updating a Reply
 * **Example:** Edit the text
 * ```typescript
 * const reply = yield* GCP.Drive.Reply("Ack", {
 *   fileId: existing.fileId,
 *   commentId: existing.commentId,
 *   replyId: existing.replyId,
 *   content: "fixed in rev 2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Drive
 */
export const Reply = Resource<Reply>("GCP.Drive.Reply");

export class ReplyNotResolved extends Data.TaggedError(
  "GCP.Drive.ReplyNotResolved",
)<{
  fileId: string;
  commentId: string;
  replyId: string;
}> {}

const toAttrs = (
  reply: drive.Reply,
  fileId: string,
  commentId: string,
  project: string,
) => ({
  replyId: reply.id ?? "",
  fileId,
  commentId,
  project,
  content: parseOwnership(reply.content).text,
  htmlContent: reply.htmlContent,
  action: reply.action,
  deleted: reply.deleted === true,
  createdTime: reply.createdTime,
  modifiedTime: reply.modifiedTime,
});

export const ReplyProvider = () =>
  Provider.succeed(Reply, {
    stables: ["replyId", "fileId", "commentId", "project", "createdTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousFile = olds?.fileId ?? output?.fileId;
      if (previousFile !== undefined && news.fileId !== previousFile) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousComment = olds?.commentId ?? output?.commentId;
      if (previousComment !== undefined && news.commentId !== previousComment) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.replyId ?? output?.replyId;
      if (
        previousId !== undefined &&
        news.replyId !== undefined &&
        news.replyId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const fileId = olds?.fileId ?? output?.fileId ?? "";
      const commentId = olds?.commentId ?? output?.commentId ?? "";
      const replyId = olds?.replyId ?? output?.replyId ?? "";
      let existing = yield* getReply(fileId, commentId, replyId);
      if (existing === undefined) {
        existing = yield* findOwnedReply(id, fileId, commentId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, fileId, commentId, env.project);
      return (yield* ownedByAlchemy(id, existing.content))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const replies = yield* listOwnedReplies();
        return replies
          .filter((reply) => hasOwnershipMarker(reply.content))
          .map((reply) =>
            toAttrs(reply, reply.fileId, reply.commentId, env.project),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const fileId = news.fileId;
      const commentId = news.commentId;
      const labels = yield* ownershipLabels(id);
      const content = encodeOwnership(labels, news.content);
      const desired: drive.Reply = {
        content,
        action: news.action,
      };

      let current = yield* getReply(
        fileId,
        commentId,
        news.replyId ?? output?.replyId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedReply(id, fileId, commentId);
      }

      if (current === undefined) {
        const created = yield* drive
          .createReplies({
            fileId,
            commentId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedReply(id, fileId, commentId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ReplyNotResolved({
          fileId,
          commentId,
          replyId: news.replyId ?? output?.replyId ?? "",
        });
      }

      const replyId = current.id ?? news.replyId ?? output?.replyId ?? "";
      const contentChanged = !sameText(current.content, content);

      if (contentChanged) {
        current = yield* drive.updateReplies({
          fileId,
          commentId,
          replyId,
          body: { content },
        });
      }

      return toAttrs(current, fileId, commentId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        output.fileId.length === 0 ||
        output.commentId.length === 0 ||
        output.replyId.length === 0
      ) {
        return;
      }
      yield* ignoreMissing(
        drive.deleteReplies({
          fileId: output.fileId,
          commentId: output.commentId,
          replyId: output.replyId,
        }),
      );
    }),
  });
