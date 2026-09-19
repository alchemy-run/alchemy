import * as factchecktools from "@distilled.cloud/gcp/factchecktools_v1alpha1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export type MarkupPage =
  factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewMarkupPage;

export const DEFAULT_AUTHOR_NAME = "Alchemy";
export const DEFAULT_TEXTUAL_RATING = "False";
export const PROBE_NAME = "pages/alchemy-missing-page";
export const PROBE_PAGE_URL = "https://example.com/fact-check/alchemy-probe";

export type ClaimRatingProps = {
  /** Human-readable rating, e.g. "False". */
  textualRating?: string;
  /** Numeric rating in the `worstRating`–`bestRating` range. */
  ratingValue?: number;
  /** Worst value on the numeric scale. */
  worstRating?: number;
  /** Best value on the numeric scale. */
  bestRating?: number;
  /** Rating image URL. */
  imageUrl?: string;
  /** Explanation of the rating. */
  ratingExplanation?: string;
};

export type ClaimAuthorProps = {
  /** Person or organization stating the claim. */
  name?: string;
  /** URL identifying the claim author. */
  sameAs?: string;
  /** Job title of the claim author. */
  jobTitle?: string;
  /** Claim-author image URL. */
  imageUrl?: string;
};

export type ClaimReviewMarkupProps = {
  /**
   * Short summary of the claim. Pages have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix on the first markup
   * and strips it from attributes.
   */
  claimReviewed?: string;
  /** Date the claim entered public discourse. */
  claimDate?: string;
  /** URL of the work where the claim first appears. */
  claimFirstAppearance?: string;
  /**
   * ClaimReview URL. Defaults to the page URL; the only permitted
   * override is the page URL plus an optional fragment.
   */
  url?: string;
  /** Location where the claim was made. */
  claimLocation?: string;
  /** Rating of this claim review. */
  rating?: ClaimRatingProps;
  /** Author of the claim being reviewed. */
  claimAuthor?: ClaimAuthorProps;
  /** Additional URLs where the claim appears. */
  claimAppearances?: string[];
};

export type ClaimReviewAuthorProps = {
  /** Organization publishing the fact check. */
  name?: string;
  /** Publisher image URL. */
  imageUrl?: string;
};

const emptyList = <A>() => Effect.succeed([] as A[]);

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, 8000);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const pageNameOf = (name: string | undefined) => {
  if (!name || name.length === 0) return "";
  return name.includes("/") ? name : `pages/${name}`;
};

export const pageIdOf = (name: string | undefined) => {
  const full = pageNameOf(name);
  return full.length === 0 ? "" : lastSegment(full);
};

export const hostnameOf = (pageUrl: string | undefined): string => {
  if (!pageUrl) return "";
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export const organizationsFromEnv = () =>
  [
    process.env.GOOGLE_FACTCHECK_ORGANIZATION,
    process.env.GCP_FACTCHECK_ORGANIZATION,
  ]
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const ratingOf = (
  rating:
    | factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimRating
    | undefined,
): ClaimRatingProps | undefined => {
  if (rating === undefined) return undefined;
  return {
    textualRating: rating.textualRating,
    ratingValue: rating.ratingValue,
    worstRating: rating.worstRating,
    bestRating: rating.bestRating,
    imageUrl: rating.imageUrl,
    ratingExplanation: rating.ratingExplanation,
  };
};

export const claimAuthorOf = (
  author:
    | factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimAuthor
    | undefined,
): ClaimAuthorProps | undefined => {
  if (author === undefined) return undefined;
  return {
    name: author.name,
    sameAs: author.sameAs,
    jobTitle: author.jobTitle,
    imageUrl: author.imageUrl,
  };
};

export const markupOf = (
  markup: factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewMarkup,
  stripOwnership: boolean,
): ClaimReviewMarkupProps => ({
  claimReviewed: stripOwnership
    ? parseOwnership(markup.claimReviewed).text
    : markup.claimReviewed,
  claimDate: markup.claimDate,
  claimFirstAppearance: markup.claimFirstAppearance,
  url: markup.url,
  claimLocation: markup.claimLocation,
  rating: ratingOf(markup.rating),
  claimAuthor: claimAuthorOf(markup.claimAuthor),
  claimAppearances: markup.claimAppearances,
});

export const markupsOf = (
  markups:
    | factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewMarkupList
    | undefined,
  stripOwnership: boolean,
): ClaimReviewMarkupProps[] =>
  (markups ?? []).map((markup) => markupOf(markup, stripOwnership));

export const authorOf = (
  author:
    | factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewAuthor
    | undefined,
): ClaimReviewAuthorProps | undefined => {
  if (author === undefined) return undefined;
  return {
    name: author.name,
    imageUrl: author.imageUrl,
  };
};

export const pageHasOwnershipMarker = (page: MarkupPage) =>
  (page.claimReviewMarkups ?? []).some((markup) =>
    hasOwnershipMarker(markup.claimReviewed),
  );

export const ownedByAlchemy = (id: string, page: MarkupPage) =>
  Effect.gen(function* () {
    for (const markup of page.claimReviewMarkups ?? []) {
      if (
        yield* hasAlchemyLabels(id, parseOwnership(markup.claimReviewed).labels)
      ) {
        return true;
      }
    }
    return false;
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toGeneratedClaim = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 80,
      lowercase: true,
    });
  });

export const toMarkupBody = (
  markup: ClaimReviewMarkupProps,
  claimReviewed: string,
): factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewMarkup => ({
  claimReviewed,
  claimDate: markup.claimDate,
  claimFirstAppearance: markup.claimFirstAppearance,
  url: markup.url,
  claimLocation: markup.claimLocation,
  rating: markup.rating,
  claimAuthor: markup.claimAuthor,
  claimAppearances: markup.claimAppearances,
});

export const stampMarkups = (
  labels: Record<string, string>,
  markups: readonly ClaimReviewMarkupProps[],
): factchecktools.GoogleFactcheckingFactchecktoolsV1alpha1ClaimReviewMarkupList =>
  markups.map((markup, index) =>
    toMarkupBody(
      markup,
      index === 0
        ? encodeOwnership(labels, markup.claimReviewed)
        : (markup.claimReviewed ?? ""),
    ),
  );

export const getPage = (name: string) =>
  pageNameOf(name).length === 0
    ? Effect.succeed(undefined)
    : factchecktools
        .getPages({ name: pageNameOf(name) })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listPagesAt = (input: factchecktools.ListPagesRequest) =>
  factchecktools.listPages
    .pages({
      ...input,
      pageSize: input.pageSize ?? 100,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.claimReviewMarkupPages ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () => emptyList<MarkupPage>()),
    );

export const findPageByUrl = (pageUrl: string | undefined) =>
  pageUrl && pageUrl.length > 0
    ? listPagesAt({ url: pageUrl }).pipe(Effect.map((pages) => pages[0]))
    : Effect.succeed(undefined);

export const listOwnedPages = () =>
  Effect.gen(function* () {
    const organizations = organizationsFromEnv();
    if (organizations.length === 0) return [] as MarkupPage[];
    const fromOrgs = yield* Effect.forEach(
      organizations,
      (organization) => listPagesAt({ organization }),
      { concurrency: 4 },
    );
    const seen = new Set<string>();
    const owned: MarkupPage[] = [];
    for (const page of fromOrgs.flat()) {
      const key = page.name ?? page.pageUrl ?? "";
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      if (pageHasOwnershipMarker(page)) owned.push(page);
    }
    return owned;
  });

export const findOwnedPage = (
  id: string,
  input: { name?: string; pageUrl?: string },
) =>
  Effect.gen(function* () {
    let existing = yield* getPage(input.name ?? "");
    if (existing === undefined) {
      existing = yield* findPageByUrl(input.pageUrl);
    }
    if (existing !== undefined) return existing;
    const owned = yield* listOwnedPages();
    for (const page of owned) {
      if (yield* ownedByAlchemy(id, page)) return page;
    }
    return undefined;
  });

export const ignoreMissing = <A, R>(
  effect: Effect.Effect<A, factchecktools.DeletePagesError, R>,
) => effect.pipe(Effect.catchTag("NotFound", () => Effect.void));
