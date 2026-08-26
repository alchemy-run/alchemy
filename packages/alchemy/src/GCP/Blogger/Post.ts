import * as blogger from "@distilled.cloud/gcp/blogger_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeContentOwnership,
  encodeCustomMetaData,
  encodeOwnershipLine,
  findOwnedPost,
  getPost,
  hasAlchemyPostMarker,
  ignoreMissing,
  imagesOf,
  isDraftStatus,
  jsonEqual,
  listOwnedPosts,
  locationOf,
  MAX_TITLE_LENGTH,
  parseContentOwnership,
  parseCustomMetaData,
  parseOwnership,
  type PostImage,
  type PostLocation,
  postOwnedByAlchemy,
  sameStringList,
  sameText,
  toGeneratedName,
  userLabelsOf,
  ownershipLabels,
} from "./internal.ts";

export type PostProps = {
  /**
   * Parent blog id. Immutable — changing it replaces the post.
   */
  blogId: string;
  /**
   * Blogger-assigned post id. Server-assigned on create. Immutable —
   * changing it replaces the post.
   */
  postId?: string;
  /**
   * Post title. If omitted, a unique name is generated from the stack,
   * stage, and logical id. Posts have no GCP labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` title prefix, an HTML comment
   * in content, and `customMetaData`, then stripped from attributes.
   */
  title?: string;
  /**
   * HTML body of the post.
   */
  content?: string;
  /**
   * Post status. Unspecified defaults to `DRAFT`.
   * @default "DRAFT"
   */
  status?: blogger.PostStatusEnum | (string & {});
  /**
   * RFC3339 timestamp when the post was published.
   */
  published?: string;
  /**
   * Title link URL, similar to Atom's related link.
   */
  titleLink?: string;
  /**
   * User labels tagged on the post.
   */
  labels?: string[];
  /**
   * JSON meta-data for the post. Alchemy ownership keys are merged in
   * automatically.
   */
  customMetaData?: string;
  /**
   * Geotag for the post.
   */
  location?: PostLocation;
  /**
   * Comment control for readers of this post.
   */
  readerComments?: blogger.PostReaderCommentsEnum | (string & {});
  /**
   * Display images for the post.
   */
  images?: PostImage[];
};

export type Post = Resource<
  "GCP.Blogger.Post",
  PostProps,
  {
    /** Blogger-assigned post id. */
    postId: string;
    /** Parent blog id. */
    blogId: string;
    /** Project id used when the post was reconciled. */
    project: string;
    /** Title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** HTML body with the Alchemy ownership comment stripped. */
    content: string | undefined;
    /** Post status. */
    status: string | undefined;
    /** Published URL. */
    url: string | undefined;
    /** API self link. */
    selfLink: string | undefined;
    /** RFC3339 publish timestamp. */
    published: string | undefined;
    /** RFC3339 last-update timestamp. */
    updated: string | undefined;
    /** RFC3339 trash timestamp, when trashed. */
    trashed: string | undefined;
    /** Title link URL. */
    titleLink: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: string[];
    /** User JSON meta-data with Alchemy ownership keys stripped. */
    customMetaData: string | undefined;
    /** Geotag. */
    location: PostLocation | undefined;
    /** Comment control. */
    readerComments: string | undefined;
    /** Display images. */
    images: PostImage[] | undefined;
    /** ETag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Blogger post on a blog.
 *
 * Posts stamp Alchemy ownership into the title, an HTML comment in
 * `content`, and `customMetaData` for `list` / nuke. Parent blog and
 * post id are identity — changing either replaces the post. Title,
 * content, labels, and draft/live status update in place.
 *
 * ### Creating a Post
 * **Example:** Draft post
 * ```typescript
 * const post = yield* GCP.Blogger.Post("Launch", {
 *   blogId: "1234567890",
 *   title: "Launch",
 *   content: "<p>hello</p>",
 *   status: "DRAFT",
 *   labels: ["news"],
 * });
 * ```
 *
 * **Example:** Generated title
 * ```typescript
 * const post = yield* GCP.Blogger.Post("Launch", {
 *   blogId: "1234567890",
 *   content: "<p>hello</p>",
 * });
 * ```
 *
 * ### Updating a Post
 * **Example:** Change the body
 * ```typescript
 * const post = yield* GCP.Blogger.Post("Launch", {
 *   blogId: existing.blogId,
 *   postId: existing.postId,
 *   title: "Launch",
 *   content: "<p>updated</p>",
 *   status: "DRAFT",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Blogger
 */
export const Post = Resource<Post>("GCP.Blogger.Post");

export class PostNotResolved extends Data.TaggedError(
  "GCP.Blogger.PostNotResolved",
)<{
  blogId: string;
  postId: string;
}> {}

const toAttrs = (post: blogger.Post, blogId: string, project: string) => ({
  postId: post.id ?? "",
  blogId: post.blog?.id ?? blogId,
  project,
  title: parseOwnership(post.title).text,
  content: parseContentOwnership(post.content).text,
  status: post.status,
  url: post.url,
  selfLink: post.selfLink,
  published: post.published,
  updated: post.updated,
  trashed: post.trashed,
  titleLink: post.titleLink,
  labels: userLabelsOf(post.labels),
  customMetaData: parseCustomMetaData(post.customMetaData).text,
  location: locationOf(post.location),
  readerComments: post.readerComments,
  images: imagesOf(post.images),
  etag: post.etag,
});

export const PostProvider = () =>
  Provider.succeed(Post, {
    stables: ["postId", "blogId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousBlog = olds?.blogId ?? output?.blogId;
      if (previousBlog !== undefined && news.blogId !== previousBlog) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.postId ?? output?.postId;
      if (
        previousId !== undefined &&
        news.postId !== undefined &&
        news.postId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const blogId = olds?.blogId ?? output?.blogId ?? "";
      const postId = olds?.postId ?? output?.postId ?? "";
      let existing = yield* getPost(blogId, postId);
      if (existing === undefined) {
        existing = yield* findOwnedPost(id, blogId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, blogId, env.project);
      return (yield* postOwnedByAlchemy(id, existing)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const posts = yield* listOwnedPosts();
        return posts
          .filter(hasAlchemyPostMarker)
          .map((post) => toAttrs(post, post.blog?.id ?? "", env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const blogId = news.blogId;
      const ownership = yield* ownershipLabels(id);
      const userTitle = yield* toGeneratedName(
        id,
        news.title,
        output?.title,
        80,
      );
      const title = encodeOwnershipLine(ownership, userTitle, MAX_TITLE_LENGTH);
      const content = encodeContentOwnership(ownership, news.content);
      const customMetaData = encodeCustomMetaData(
        ownership,
        news.customMetaData,
      );
      const status = news.status ?? output?.status ?? "DRAFT";
      const labels = news.labels;
      const desired: blogger.Post = {
        title,
        content,
        published: news.published,
        titleLink: news.titleLink,
        labels,
        customMetaData,
        location: news.location,
        readerComments: news.readerComments,
        images: news.images,
      };

      let current = yield* getPost(blogId, news.postId ?? output?.postId ?? "");
      if (current === undefined) {
        current = yield* findOwnedPost(id, blogId);
      }

      if (current === undefined) {
        const created = yield* blogger
          .insertPosts({
            blogId,
            isDraft: isDraftStatus(status),
            fetchBody: true,
            fetchImages: true,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedPost(id, blogId)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PostNotResolved({
          blogId,
          postId: news.postId ?? output?.postId ?? "",
        });
      }

      const postId = current.id ?? news.postId ?? output?.postId ?? "";
      const titleChanged = !sameText(current.title, title);
      const contentChanged = !sameText(current.content, content);
      const metaChanged = !sameText(current.customMetaData, customMetaData);
      const publishedChanged =
        news.published !== undefined &&
        !sameText(current.published, news.published);
      const titleLinkChanged =
        news.titleLink !== undefined &&
        !sameText(current.titleLink, news.titleLink);
      const labelsChanged =
        labels !== undefined && !sameStringList(current.labels, labels);
      const locationChanged =
        news.location !== undefined &&
        !jsonEqual(locationOf(current.location), news.location);
      const commentsChanged =
        news.readerComments !== undefined &&
        !sameText(current.readerComments, news.readerComments);
      const imagesChanged =
        news.images !== undefined &&
        !jsonEqual(imagesOf(current.images), news.images);
      const currentStatus = current.status ?? "LIVE";
      const statusChanged = currentStatus !== status;
      const shouldPublish = statusChanged && status === "LIVE";
      const shouldRevert = statusChanged && isDraftStatus(status);

      if (
        titleChanged ||
        contentChanged ||
        metaChanged ||
        publishedChanged ||
        titleLinkChanged ||
        labelsChanged ||
        locationChanged ||
        commentsChanged ||
        imagesChanged ||
        shouldPublish ||
        shouldRevert
      ) {
        current = yield* blogger
          .updatePosts({
            blogId,
            postId,
            fetchBody: true,
            fetchImages: true,
            publish: shouldPublish ? true : undefined,
            revert: shouldRevert ? true : undefined,
            body: {
              ...desired,
              id: postId,
              etag: current.etag,
            },
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              blogger.insertPosts({
                blogId,
                isDraft: isDraftStatus(status),
                fetchBody: true,
                fetchImages: true,
                body: desired,
              }),
            ),
          );
      }

      const fresh = yield* getPost(blogId, current.id ?? postId);
      return toAttrs(fresh ?? current, blogId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.blogId.length === 0 || output.postId.length === 0) return;
      yield* ignoreMissing(
        blogger.deletePosts({
          blogId: output.blogId,
          postId: output.postId,
          useTrash: false,
        }),
      );
    }),
  });
