import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** DigitalOcean's maximum `per_page`. */
export const PAGE_SIZE = 200;

/** A pager that never reports a last page fails instead of looping. */
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
  readonly meta?: { readonly total?: number | undefined } | undefined;
}

const hasNextLink = (envelope: PageEnvelope): boolean => {
  const pages = envelope.links?.pages;
  if (typeof pages !== "object" || pages === null) return false;
  return typeof (pages as { next?: unknown }).next === "string";
};

const hasNextPage = (
  envelope: PageEnvelope,
  pageSize: number,
  collected: number,
): boolean => {
  if (hasNextLink(envelope)) return true;
  if (pageSize === 0) return false;
  const total = envelope.meta?.total;
  if (total === undefined) return false;
  return collected < total;
};

/**
 * Walks a paginated DigitalOcean list to its end. A page is the last one
 * when it carries no `links.pages.next` and `meta.total` is reached.
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
      if (!hasNextPage(response, pageItems.length, items.length)) return items;
    }
    return yield* new DigitalOceanPageOverflow({ pages: MAX_PAGES });
  });
