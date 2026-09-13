import * as realtimeKit from "@distilled.cloud/cloudflare/realtime-kit";
import * as Effect from "effect/Effect";

/**
 * Exhaustively enumerate every RealtimeKit app in the account. The list op is
 * not generated as a paginated method, so fetch the first page, derive the
 * page count from `paging.totalCount`, then fan out the remaining pages with
 * bounded concurrency.
 */
export const listAllApps = (accountId: string, perPage = 100) =>
  Effect.gen(function* () {
    const first = yield* realtimeKit.getApp({
      accountId,
      pageNo: 1,
      perPage: perPage,
    });
    const apps = (first.data ?? []).filter(
      (a): a is NonNullable<typeof a> => a !== null,
    );
    const total = first.paging?.totalCount ?? apps.length;
    const pages = Math.ceil(total / perPage);
    if (pages <= 1) return apps;
    const rest = yield* Effect.forEach(
      Array.from({ length: pages - 1 }, (_, i) => i + 2),
      (pageNo) =>
        realtimeKit
          .getApp({ accountId, pageNo, perPage: perPage })
          .pipe(
            Effect.map((res) =>
              (res.data ?? []).filter(
                (a): a is NonNullable<typeof a> => a !== null,
              ),
            ),
          ),
      { concurrency: 10 },
    );
    return [...apps, ...rest.flat()];
  });

/**
 * Error raised when a deploy attempts to rename a RealtimeKit app. The API
 * has neither an update endpoint (to rename in place) nor a delete endpoint
 * (to model the change as a replacement).
 */
