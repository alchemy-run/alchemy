import * as factchecktools from "@distilled.cloud/gcp/factchecktools_v1alpha1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  authorOf,
  DEFAULT_AUTHOR_NAME,
  DEFAULT_TEXTUAL_RATING,
  findOwnedPage,
  findPageByUrl,
  getPage,
  hostnameOf,
  ignoreMissing,
  jsonEqual,
  listOwnedPages,
  markupsOf,
  ownedByAlchemy,
  ownershipLabels,
  pageHasOwnershipMarker,
  pageIdOf,
  pageNameOf,
  sameText,
  stampMarkups,
  toGeneratedClaim,
  type ClaimReviewAuthorProps,
  type ClaimReviewMarkupProps,
} from "./internal.ts";

export type {
  ClaimAuthorProps,
  ClaimRatingProps,
  ClaimReviewAuthorProps,
  ClaimReviewMarkupProps,
} from "./internal.ts";

export type PageProps = {
  /**
   * Resource name `pages/{page_id}` or the `{page_id}` segment.
   * Server-assigned on create. Immutable — changing it replaces the
   * page.
   */
  name?: string;
  /**
   * URL of the webpage this ClaimReview markup is associated with.
   * Required on create. Immutable — changing it replaces the page.
   */
  pageUrl: string;
  /**
   * Organization host used by `pages.list` (for example `site.com`).
   * Defaults to the hostname of `pageUrl` without a leading `www.`.
   */
  organization?: string;
  /**
   * Date the fact check was published (`ClaimReview.datePublished`).
   */
  publishDate?: string;
  /**
   * Organization publishing the fact check.
   */
  claimReviewAuthor?: ClaimReviewAuthorProps;
  /**
   * Individual claim reviews on this page. When omitted, Alchemy
   * creates one markup whose `claimReviewed` is generated from the
   * stack, stage, and logical id.
   */
  claimReviewMarkups?: ClaimReviewMarkupProps[];
};

export interface Page extends Resource<
  "GCP.Factchecktools.Page",
  PageProps,
  {
    /** Resource name `pages/{page_id}`. */
    name: string;
    /** Page id (last path segment). */
    pageId: string;
    /** Project id used when the page was reconciled. */
    project: string;
    /** Webpage URL associated with this markup. */
    pageUrl: string | undefined;
    /** Organization host derived from `pageUrl` or the prop. */
    organization: string | undefined;
    /** Publish date. */
    publishDate: string | undefined;
    /** Claim-review author. */
    claimReviewAuthor: ClaimReviewAuthorProps | undefined;
    /**
     * Claim reviews with the Alchemy ownership prefix stripped from
     * the first `claimReviewed`.
     */
    claimReviewMarkups: ClaimReviewMarkupProps[];
    /** Server-assigned markup version id. */
    versionId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Fact Check Tools ClaimReview markup page.
 *
 * Pages have no labels field, so Alchemy stamps ownership into the
 * first `claimReviewMarkups.claimReviewed` for `list` / nuke. Resource
 * name and `pageUrl` are identity — changing either replaces the page.
 * Author, publish date, and claim reviews update in place via a full
 * `pages.update`. Creating markup requires the
 * `https://www.googleapis.com/auth/factchecktools` scope and a
 * verified fact-checking organization for `pageUrl`.
 *
 * ### Creating a Page
 * **Example:** Single claim review
 * ```typescript
 * const page = yield* GCP.Factchecktools.Page("Review", {
 *   pageUrl: "https://example.com/fact-check/claim",
 *   claimReviewAuthor: { name: "Alchemy Checks" },
 *   claimReviewMarkups: [
 *     {
 *       claimReviewed: "The moon is made of cheese",
 *       rating: { textualRating: "False" },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Generated claim text
 * ```typescript
 * const page = yield* GCP.Factchecktools.Page("Review", {
 *   pageUrl: "https://example.com/fact-check/claim",
 * });
 * ```
 *
 * ### Updating a Page
 * **Example:** Change the rating
 * ```typescript
 * const page = yield* GCP.Factchecktools.Page("Review", {
 *   name: existing.name,
 *   pageUrl: existing.pageUrl ?? "https://example.com/fact-check/claim",
 *   claimReviewMarkups: [
 *     {
 *       claimReviewed: "The moon is made of cheese",
 *       rating: { textualRating: "Pants on fire" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Factchecktools
 */
export const Page = Resource<Page>("GCP.Factchecktools.Page");

export class PageNotResolved extends Data.TaggedError(
  "GCP.Factchecktools.PageNotResolved",
)<{
  name: string;
  pageUrl: string;
}> {}

const organizationOf = (
  pageUrl: string | undefined,
  organization: string | undefined,
) => {
  if (organization && organization.length > 0) return organization;
  const host = hostnameOf(pageUrl);
  return host.length > 0 ? host : undefined;
};

const toAttrs = (
  page: factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewMarkupPage,
  project: string,
  organization: string | undefined,
) => {
  const name = pageNameOf(page.name);
  return {
    name,
    pageId: pageIdOf(name),
    project,
    pageUrl: page.pageUrl,
    organization: organizationOf(page.pageUrl, organization),
    publishDate: page.publishDate,
    claimReviewAuthor: authorOf(page.claimReviewAuthor),
    claimReviewMarkups: markupsOf(page.claimReviewMarkups, true),
    versionId: page.versionId,
  };
};

const defaultMarkups = (claimReviewed: string): ClaimReviewMarkupProps[] => [
  {
    claimReviewed,
    rating: { textualRating: DEFAULT_TEXTUAL_RATING },
  },
];

export const PageProvider = () =>
  Provider.succeed(Page, {
    stables: ["name", "pageId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = pageNameOf(olds?.name ?? output?.name);
      const nextName = pageNameOf(news.name);
      if (
        previousName.length > 0 &&
        nextName.length > 0 &&
        previousName !== nextName
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousUrl = olds?.pageUrl ?? output?.pageUrl;
      if (
        previousUrl !== undefined &&
        previousUrl.length > 0 &&
        news.pageUrl !== previousUrl
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* findOwnedPage(id, {
        name: olds?.name ?? output?.name,
        pageUrl: olds?.pageUrl ?? output?.pageUrl,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        env.project,
        olds?.organization ?? output?.organization,
      );
      return (yield* ownedByAlchemy(id, existing)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* listOwnedPages();
        return pages
          .filter(pageHasOwnershipMarker)
          .map((page) => toAttrs(page, env.project, undefined));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* ownershipLabels(id);
      const existingClaim = output?.claimReviewMarkups?.[0]?.claimReviewed;
      const userMarkups =
        news.claimReviewMarkups && news.claimReviewMarkups.length > 0
          ? news.claimReviewMarkups
          : defaultMarkups(
              yield* toGeneratedClaim(id, undefined, existingClaim),
            );
      const first = userMarkups[0]!;
      const claimed = yield* toGeneratedClaim(
        id,
        first.claimReviewed,
        existingClaim,
      );
      const desiredMarkups = stampMarkups(ownership, [
        { ...first, claimReviewed: claimed },
        ...userMarkups.slice(1),
      ]);
      const desiredAuthor = {
        name: news.claimReviewAuthor?.name ?? DEFAULT_AUTHOR_NAME,
        imageUrl: news.claimReviewAuthor?.imageUrl,
      };
      const desiredBody: factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewMarkupPage =
        {
          pageUrl: news.pageUrl,
          publishDate: news.publishDate,
          claimReviewAuthor: desiredAuthor,
          claimReviewMarkups: desiredMarkups,
        };

      let current = yield* findOwnedPage(id, {
        name: news.name ?? output?.name,
        pageUrl: news.pageUrl ?? output?.pageUrl,
      });

      if (current === undefined) {
        const created = yield* factchecktools
          .createPages({ body: desiredBody })
          .pipe(Effect.catchTag("Conflict", () => findPageByUrl(news.pageUrl)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PageNotResolved({
          name: pageNameOf(news.name ?? output?.name),
          pageUrl: news.pageUrl,
        });
      }

      const name = pageNameOf(current.name);
      const markupsChanged = !jsonEqual(
        current.claimReviewMarkups ?? [],
        desiredMarkups,
      );
      const authorChanged = !jsonEqual(
        authorOf(current.claimReviewAuthor),
        desiredAuthor,
      );
      const urlChanged = !sameText(current.pageUrl, news.pageUrl);
      const dateChanged =
        news.publishDate !== undefined &&
        (current.publishDate ?? "") !== news.publishDate;

      if (markupsChanged || authorChanged || urlChanged || dateChanged) {
        const updated = yield* factchecktools
          .updatePages({
            name,
            body: {
              ...desiredBody,
              name,
              versionId: current.versionId,
            },
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              factchecktools.createPages({ body: desiredBody }),
            ),
            Effect.catchTag("Conflict", () => findPageByUrl(news.pageUrl)),
          );
        current = updated ?? current;
      }

      const fresh = yield* getPage(current.name ?? name);
      return toAttrs(
        fresh ?? current,
        env.project,
        news.organization ?? output?.organization,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = pageNameOf(output.name);
      if (name.length === 0) return;
      yield* ignoreMissing(factchecktools.deletePages({ name }));
    }),
  });
