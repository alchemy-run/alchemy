import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

const MAX_PER_PAGE = 200;

/** Guards against a list whose `next` link never ends. */
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

export interface PageEnvelope {
  readonly links?: { readonly pages?: unknown } | undefined;
}

// The SDK types `links.pages` as `unknown`.
const hasNextLink = (envelope: PageEnvelope): boolean => {
  const pages = envelope.links?.pages;
  return Predicate.hasProperty(pages, "next") && Predicate.isString(pages.next);
};

/** Collects the items of every page of a DigitalOcean list. */
export const collectPages = <Item, Response extends PageEnvelope, E, R>(
  fetchPage: (query: PageQuery) => Effect.Effect<Response, E, R>,
  selectItems: (response: Response) => ReadonlyArray<Item>,
): Effect.Effect<Item[], E | DigitalOceanPageOverflow, R> =>
  Effect.gen(function* () {
    const items: Item[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = yield* fetchPage({ page, per_page: MAX_PER_PAGE });
      const pageItems = selectItems(response);
      items.push(...pageItems);
      // An empty page ends the list even when it still carries a next link.
      if (pageItems.length === 0 || !hasNextLink(response)) return items;
    }
    return yield* new DigitalOceanPageOverflow({ pages: MAX_PAGES });
  });
