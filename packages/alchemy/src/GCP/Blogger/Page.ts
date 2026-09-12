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
  encodeOwnershipLine,
  findOwnedPage,
  getPage,
  hasAlchemyPageMarker,
  ignoreMissing,
  isDraftStatus,
  listOwnedPages,
  MAX_TITLE_LENGTH,
  pageOwnedByAlchemy,
  parseContentOwnership,
  parseOwnership,
  sameText,
  toGeneratedName,
  ownershipLabels,
} from "./internal.ts";

export type PageProps = {
  /**
   * Parent blog id. Immutable — changing it replaces the page.
   */
  blogId: string;
  /**
   * Blogger-assigned page id. Server-assigned on create. Immutable —
   * changing it replaces the page.
   */
  pageId?: string;
  /**
   * Page title. If omitted, a unique name is generated from the stack,
   * stage, and logical id. Pages have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix on the title and an
   * HTML comment in content, then stripped from attributes.
   */
  title?: string;
  /**
   * HTML body of the page.
   */
  content?: string;
  /**
   * Page status. Unspecified defaults to `DRAFT`.
   * @default "DRAFT"
   */
  status?: blogger.PageStatusEnum | (string & {});
  /**
   * RFC3339 timestamp when the page was published.
   */
  published?: string;
};

export type Page = Resource<
  "GCP.Blogger.Page",
  PageProps,
  {
    /** Blogger-assigned page id. */
    pageId: string;
    /** Parent blog id. */
    blogId: string;
    /** Project id used when the page was reconciled. */
    project: string;
    /** Title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** HTML body with the Alchemy ownership comment stripped. */
    content: string | undefined;
    /** Page status. */
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
    /** ETag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Blogger page on a blog.
 *
 * Pages have no labels field, so Alchemy stamps ownership into the
 * title and an HTML comment in `content` for `list` / nuke. Parent blog
 * and page id are identity — changing either replaces the page. Title,
 * content, and draft/live status update in place.
 *
 * ### Creating a Page
 * **Example:** Draft page
 * ```typescript
 * const page = yield* GCP.Blogger.Page("About", {
 *   blogId: "1234567890",
 *   title: "About",
 *   content: "<p>hello</p>",
 *   status: "DRAFT",
 * });
 * ```
 *
 * **Example:** Generated title
 * ```typescript
 * const page = yield* GCP.Blogger.Page("About", {
 *   blogId: "1234567890",
 *   content: "<p>hello</p>",
 * });
 * ```
 *
 * ### Updating a Page
 * **Example:** Change the body
 * ```typescript
 * const page = yield* GCP.Blogger.Page("About", {
 *   blogId: existing.blogId,
 *   pageId: existing.pageId,
 *   title: "About",
 *   content: "<p>updated</p>",
 *   status: "DRAFT",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Blogger
 */
export const Page = Resource<Page>("GCP.Blogger.Page");

export class PageNotResolved extends Data.TaggedError(
  "GCP.Blogger.PageNotResolved",
)<{
  blogId: string;
  pageId: string;
}> {}

const toAttrs = (page: blogger.Page, blogId: string, project: string) => ({
  pageId: page.id ?? "",
  blogId: page.blog?.id ?? blogId,
  project,
  title: parseOwnership(page.title).text,
  content: parseContentOwnership(page.content).text,
  status: page.status,
  url: page.url,
  selfLink: page.selfLink,
  published: page.published,
  updated: page.updated,
  trashed: page.trashed,
  etag: page.etag,
});

export const PageProvider = () =>
  Provider.succeed(Page, {
    stables: ["pageId", "blogId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousBlog = olds?.blogId ?? output?.blogId;
      if (previousBlog !== undefined && news.blogId !== previousBlog) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.pageId ?? output?.pageId;
      if (
        previousId !== undefined &&
        news.pageId !== undefined &&
        news.pageId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const blogId = olds?.blogId ?? output?.blogId ?? "";
      const pageId = olds?.pageId ?? output?.pageId ?? "";
      let existing = yield* getPage(blogId, pageId);
      if (existing === undefined) {
        existing = yield* findOwnedPage(id, blogId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, blogId, env.project);
      return (yield* pageOwnedByAlchemy(id, existing)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* listOwnedPages();
        return pages
          .filter(hasAlchemyPageMarker)
          .map((page) => toAttrs(page, page.blog?.id ?? "", env.project));
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
      const status = news.status ?? output?.status ?? "DRAFT";
      const desired: blogger.Page = {
        title,
        content,
        published: news.published,
      };

      let current = yield* getPage(blogId, news.pageId ?? output?.pageId ?? "");
      if (current === undefined) {
        current = yield* findOwnedPage(id, blogId);
      }

      if (current === undefined) {
        const created = yield* blogger
          .insertPages({
            blogId,
            isDraft: isDraftStatus(status),
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedPage(id, blogId)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PageNotResolved({
          blogId,
          pageId: news.pageId ?? output?.pageId ?? "",
        });
      }

      const pageId = current.id ?? news.pageId ?? output?.pageId ?? "";
      const titleChanged = !sameText(current.title, title);
      const contentChanged = !sameText(current.content, content);
      const publishedChanged =
        news.published !== undefined &&
        !sameText(current.published, news.published);
      const currentStatus = current.status ?? "LIVE";
      const statusChanged = currentStatus !== status;
      const shouldPublish = statusChanged && status === "LIVE";
      const shouldRevert = statusChanged && isDraftStatus(status);

      if (
        titleChanged ||
        contentChanged ||
        publishedChanged ||
        shouldPublish ||
        shouldRevert
      ) {
        current = yield* blogger
          .updatePages({
            blogId,
            pageId,
            publish: shouldPublish ? true : undefined,
            revert: shouldRevert ? true : undefined,
            body: {
              ...desired,
              id: pageId,
              etag: current.etag,
            },
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              blogger.insertPages({
                blogId,
                isDraft: isDraftStatus(status),
                body: desired,
              }),
            ),
          );
      }

      const fresh = yield* getPage(blogId, current.id ?? pageId);
      return toAttrs(fresh ?? current, blogId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.blogId.length === 0 || output.pageId.length === 0) return;
      yield* ignoreMissing(
        blogger.deletePages({
          blogId: output.blogId,
          pageId: output.pageId,
          useTrash: false,
        }),
      );
    }),
  });
