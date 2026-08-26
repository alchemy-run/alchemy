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
  findOwnedComment,
  getComment,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listOwnedComments,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  type QuotedFileContent,
  quotedContentOf,
  sameText,
} from "./internal.ts";

export type CommentProps = {
  /**
   * Parent file id. Immutable — changing it replaces the comment.
   */
  fileId: string;
  /**
   * Drive-assigned comment id. Server-assigned on create. Immutable —
   * changing it replaces the comment.
   */
  commentId?: string;
  /**
   * Plain-text content. Drive comments have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  content?: string;
  /**
   * Region of the document represented as a JSON string.
   */
  anchor?: string;
  /**
   * File content the comment refers to.
   */
  quotedFileContent?: QuotedFileContent;
};

export type Comment = Resource<
  "GCP.Drive.Comment",
  CommentProps,
  {
    /** Drive-assigned comment id. */
    commentId: string;
    /** Parent file id. */
    fileId: string;
    /** Project id used when the comment was reconciled. */
    project: string;
    /** User content with the Alchemy ownership prefix stripped. */
    content: string | undefined;
    /** HTML content. */
    htmlContent: string | undefined;
    /** Anchor region. */
    anchor: string | undefined;
    /** Quoted file content. */
    quotedFileContent: QuotedFileContent | undefined;
    /** Whether the comment is resolved. */
    resolved: boolean;
    /** Whether the comment is deleted. */
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
 * A comment on a Google Drive file.
 *
 * Alchemy stamps ownership into `content` for `list` / nuke. Parent file
 * and comment id are identity. Content, anchor, and quoted file content
 * update in place. Comments require a Docs Editors file or a file with
 * binary content.
 *
 * ### Creating a Comment
 * **Example:** Comment on a document
 * ```typescript
 * const comment = yield* GCP.Drive.Comment("Kickoff", {
 *   fileId: file.fileId,
 *   content: "please review the intro",
 * });
 * ```
 *
 * ### Updating a Comment
 * **Example:** Edit the text
 * ```typescript
 * const comment = yield* GCP.Drive.Comment("Kickoff", {
 *   fileId: existing.fileId,
 *   commentId: existing.commentId,
 *   content: "please review section 2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Drive
 */
export const Comment = Resource<Comment>("GCP.Drive.Comment");

export class CommentNotResolved extends Data.TaggedError(
  "GCP.Drive.CommentNotResolved",
)<{
  fileId: string;
  commentId: string;
}> {}

const toAttrs = (comment: drive.Comment, fileId: string, project: string) => ({
  commentId: comment.id ?? "",
  fileId,
  project,
  content: parseOwnership(comment.content).text,
  htmlContent: comment.htmlContent,
  anchor: comment.anchor,
  quotedFileContent: quotedContentOf(comment.quotedFileContent),
  resolved: comment.resolved === true,
  deleted: comment.deleted === true,
  createdTime: comment.createdTime,
  modifiedTime: comment.modifiedTime,
});

export const CommentProvider = () =>
  Provider.succeed(Comment, {
    stables: ["commentId", "fileId", "project", "createdTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousFile = olds?.fileId ?? output?.fileId;
      if (previousFile !== undefined && news.fileId !== previousFile) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.commentId ?? output?.commentId;
      if (
        previousId !== undefined &&
        news.commentId !== undefined &&
        news.commentId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const fileId = olds?.fileId ?? output?.fileId ?? "";
      const commentId = olds?.commentId ?? output?.commentId ?? "";
      let existing = yield* getComment(fileId, commentId);
      if (existing === undefined) {
        existing = yield* findOwnedComment(id, fileId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, fileId, env.project);
      return (yield* ownedByAlchemy(id, existing.content))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const comments = yield* listOwnedComments();
        return comments
          .filter((comment) => hasOwnershipMarker(comment.content))
          .map((comment) => toAttrs(comment, comment.fileId, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const fileId = news.fileId;
      const labels = yield* ownershipLabels(id);
      const content = encodeOwnership(labels, news.content);
      const desired: drive.Comment = {
        content,
        anchor: news.anchor,
        quotedFileContent: news.quotedFileContent,
      };

      let current = yield* getComment(
        fileId,
        news.commentId ?? output?.commentId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedComment(id, fileId);
      }

      if (current === undefined) {
        const created = yield* drive
          .createComments({
            fileId,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedComment(id, fileId)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CommentNotResolved({
          fileId,
          commentId: news.commentId ?? output?.commentId ?? "",
        });
      }

      const commentId = current.id ?? news.commentId ?? output?.commentId ?? "";
      const contentChanged = !sameText(current.content, content);
      const anchorChanged =
        news.anchor !== undefined && !sameText(current.anchor, news.anchor);
      const quotedChanged =
        news.quotedFileContent !== undefined &&
        !jsonEqual(
          quotedContentOf(current.quotedFileContent),
          news.quotedFileContent,
        );

      if (contentChanged || anchorChanged || quotedChanged) {
        current = yield* drive.updateComments({
          fileId,
          commentId,
          body: desired,
        });
      }

      return toAttrs(current, fileId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.fileId.length === 0 || output.commentId.length === 0) return;
      yield* ignoreMissing(
        drive.deleteComments({
          fileId: output.fileId,
          commentId: output.commentId,
        }),
      );
    }),
  });
