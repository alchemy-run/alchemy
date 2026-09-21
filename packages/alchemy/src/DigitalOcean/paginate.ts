import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** DigitalOcean's maximum `per_page`. */
export const PAGE_SIZE = 200;

/** Stop after this many pages. A list that never ends fails instead of looping. */
const MAX_PAGES = 500;

export class DigitalOceanPageOverflow extends Data.TaggedError(
  "DigitalOceanPageOverflow",
)<{ readonly pages: number }> {
  override get message() {
    return `DigitalOcean list did not end after ${this.pages} pages.`;
  }
}

export interface PageQuery {
  readonly page: number;
  readonly per_page: number;
}

/** The pagination envelope on every DigitalOcean list response. */
export interface PageEnvelope {
  readonly links?: { readonly pages?: unknown } | undefined;
}

/** The SDK types `links.pages` as `unknown`. */
const hasNextLink = (envelope: PageEnvelope): boolean => {
  const pages = envelope.links?.pages;
  if (typeof pages !== "object" || pages === null) return false;
  return typeof (pages as { next?: unknown }).next === "string";
};

const hasNextPage = (envelope: PageEnvelope, pageItemCount: number): boolean =>
  pageItemCount > 0 && hasNextLink(envelope);

/**
 * Reads every page of a DigitalOcean list. The last page has no
 * `links.pages.next`.
 */
export const listAllPages = <A, Response extends PageEnvelope, E, R>(
  fetchPage: (query: PageQuery) => Effect.Effect<Response, E, R>,
  selectItems: (response: Response) => ReadonlyArray<A>,
): Effect.Effect<A[], E | DigitalOceanPageOverflow, R> =>
  Effect.gen(function* () {
    const items: A[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = yield* fetchPage({ page, per_page: PAGE_SIZE });
      const pageItems = selectItems(response);
      items.push(...pageItems);
      if (!hasNextPage(response, pageItems.length)) return items;
    }
    return yield* new DigitalOceanPageOverflow({ pages: MAX_PAGES });
  });
