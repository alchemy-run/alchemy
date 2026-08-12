import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** DigitalOcean's maximum `per_page`. */
export const PAGE_SIZE = 200;

// The page-links envelope is an untyped oneOf in the spec, so termination is
// length-based; the cap turns a misbehaving pager into a loud failure
// instead of an infinite loop.
const MAX_PAGES = 500;

export class DigitalOceanPageOverflow extends Data.TaggedError(
  "DigitalOceanPageOverflow",
)<{ readonly pages: number }> {}

/** Walk a paginated DigitalOcean list to exhaustion. */
export const listAllPages = <A, E, R>(
  fetchPage: (query: {
    page: number;
    per_page: number;
  }) => Effect.Effect<ReadonlyArray<A>, E, R>,
): Effect.Effect<A[], E | DigitalOceanPageOverflow, R> =>
  Effect.gen(function* () {
    const out: A[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = yield* fetchPage({ page, per_page: PAGE_SIZE });
      out.push(...items);
      if (items.length < PAGE_SIZE) return out;
    }
    return yield* new DigitalOceanPageOverflow({ pages: MAX_PAGES });
  });
