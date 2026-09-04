import {
  DigitalOceanPageOverflow,
  listAllPages,
  PAGE_SIZE,
  type PageEnvelope,
  type PageQuery,
} from "@/DigitalOcean/paginate";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

type Page = PageEnvelope & { readonly items: ReadonlyArray<number> };

const itemsOf = (page: number, count: number) =>
  Array.from({ length: count }, (_, i) => (page - 1) * PAGE_SIZE + i);

/** Records every query and answers each page from `pages` by number. */
const fakeList = (pages: ReadonlyArray<Page>) => {
  const queries: PageQuery[] = [];
  const fetchPage = (query: PageQuery) => {
    queries.push(query);
    return Effect.succeed(pages[query.page - 1] ?? { items: [] });
  };
  return { queries, fetchPage };
};

const collect = (pages: ReadonlyArray<Page>) => {
  const list = fakeList(pages);
  return Effect.map(
    listAllPages(list.fetchPage, (page) => page.items),
    (items) => ({ items, queries: list.queries }),
  );
};

describe("listAllPages", () => {
  it.effect("follows links.pages.next until a page has no next link", () =>
    Effect.gen(function* () {
      const { items, queries } = yield* collect([
        {
          items: itemsOf(1, PAGE_SIZE),
          links: { pages: { next: "?page=2" } },
        },
        { items: itemsOf(2, 50), links: { pages: {} } },
      ]);
      expect(items).toEqual(itemsOf(1, 250));
      expect(queries).toEqual([
        { page: 1, per_page: PAGE_SIZE },
        { page: 2, per_page: PAGE_SIZE },
      ]);
    }),
  );

  it.effect("stops at a full page without a next link", () =>
    Effect.gen(function* () {
      const { items, queries } = yield* collect([
        { items: itemsOf(1, PAGE_SIZE), links: {} },
      ]);
      expect(items).toHaveLength(PAGE_SIZE);
      expect(queries).toHaveLength(1);
    }),
  );

  it.effect("stops at a short page with no envelope", () =>
    Effect.gen(function* () {
      const { items, queries } = yield* collect([
        { items: itemsOf(1, PAGE_SIZE - 1) },
      ]);
      expect(items).toHaveLength(PAGE_SIZE - 1);
      expect(queries).toHaveLength(1);
    }),
  );

  it.effect("stops at an empty page even when it has a next link", () =>
    Effect.gen(function* () {
      const { queries } = yield* collect([
        { items: [], links: { pages: { next: "?page=2" } } },
      ]);
      expect(queries).toHaveLength(1);
    }),
  );

  it.effect(
    "fails with DigitalOceanPageOverflow when the list never ends",
    () =>
      Effect.gen(function* () {
        const endless = (_: PageQuery) =>
          Effect.succeed<Page>({
            items: [1],
            links: { pages: { next: "?page=next" } },
          });
        const error = yield* Effect.flip(
          listAllPages(endless, (page) => page.items),
        );
        expect(error).toBeInstanceOf(DigitalOceanPageOverflow);
        expect(error.pages).toEqual(500);
      }),
  );
});
