import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * Largest page size Forgejo accepts on its paginated list endpoints.
 */
export const PAGE_LIMIT = 50;

/**
 * Upper bound on pages walked by {@link paginate}, so a server that never
 * reports an empty page cannot spin forever.
 */
export const MAX_PAGES = 100;

/**
 * A list endpoint returned more pages than {@link MAX_PAGES} allows.
 *
 * Enumeration powers account-wide operations such as `alchemy nuke`, so a
 * silently truncated list would under-report and leave resources behind.
 */
export class ForgejoPaginationLimit extends Data.TaggedError(
  "ForgejoPaginationLimit",
)<{
  /**
   * Number of pages walked before giving up.
   */
  readonly pages: number;
  /**
   * Entries requested per page.
   */
  readonly limit: number;
}> {
  /**
   * Human-readable description of the incomplete enumeration.
   */
  override get message(): string {
    return `Listing exceeded ${this.pages} pages of ${this.limit} entries; enumeration would be incomplete.`;
  }
}

/**
 * The page-number inputs every Forgejo list operation accepts.
 */
export interface PageInput {
  readonly page?: number;
  readonly limit?: number;
}

/**
 * Walk every page of a Forgejo list operation.
 *
 * Forgejo paginates list responses (30 entries by default) and signals the
 * end only through an `X-Total-Count` header, not in the body, so the
 * generated SDK carries no pagination trait for these operations and a
 * single call silently truncates enumeration. Paging stops at the first
 * empty page — not the first short one, since the instance may clamp the
 * page size below {@link PAGE_LIMIT}. Hitting {@link MAX_PAGES} fails with
 * {@link ForgejoPaginationLimit} rather than returning a list that only
 * looks complete.
 */
export const paginate = <I extends PageInput, T, E, R>(
  operation: (input: I) => Effect.Effect<ReadonlyArray<T>, E, R>,
  input: Omit<I, keyof PageInput>,
): Effect.Effect<ReadonlyArray<T>, E | ForgejoPaginationLimit, R> => {
  const go = (
    page: number,
    accumulated: ReadonlyArray<T>,
  ): Effect.Effect<ReadonlyArray<T>, E | ForgejoPaginationLimit, R> =>
    operation({ ...input, page, limit: PAGE_LIMIT } as I).pipe(
      Effect.flatMap((items) => {
        const combined = [...accumulated, ...items];
        // Stop only on an empty page, never on a short one. Forgejo clamps
        // the requested `limit` to the instance's `[api] MAX_RESPONSE_ITEMS`,
        // so on a server whose administrator lowered that below PAGE_LIMIT
        // every full page looks short — treating short as "last" would end
        // enumeration after page one and silently report a partial list as
        // complete.
        if (items.length === 0) {
          return Effect.succeed(combined);
        }
        return page >= MAX_PAGES
          ? new ForgejoPaginationLimit({ pages: MAX_PAGES, limit: PAGE_LIMIT })
          : go(page + 1, combined);
      }),
    );

  return go(1, []);
};
