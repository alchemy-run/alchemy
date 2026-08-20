import {
  DeleteRadarValueListItemsItem,
  GetRadarValueListItems,
  GetRadarValueListItemsItem,
  GetRadarValueLists,
  PostRadarValueListItems,
  type RadarValueListItem as StripeValueListItem,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * Items (and value lists) are enumerated 100 at a time; the cap keeps a
 * runaway cursor from looping forever.
 */
const MAX_PAGES = 100;

export type RadarValueListItemProps = {
  /**
   * The `valueListId` of the `Stripe.RadarValueList` this item belongs to.
   * Immutable — moving an item to a different list replaces it.
   */
  valueListId: string;
  /**
   * The value to add to the list. Must match the parent list's `itemType`
   * (an email address for an `email` list, a CIDR/IP for an `ip_address`
   * list, …). Immutable — changing the value replaces the item.
   */
  value: string;
};

export type RadarValueListItem = Resource<
  "Stripe.RadarValueListItem",
  RadarValueListItemProps,
  {
    /** Stripe's unique identifier for the item (`rsli_…`). */
    valueListItemId: string;
    /** The id of the value list this item belongs to. */
    valueListId: string;
    /** The value held by the item. */
    value: string;
    /** The name or email address of the user who added the item. */
    createdBy: string;
    /** Creation time, in seconds since the Unix epoch. */
    created: number;
    /** `true` when the item lives in live mode rather than test mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

type RadarValueListItemAttributes = RadarValueListItem["Attributes"];

/**
 * A single entry in a Stripe Radar value list.
 *
 * Value list items are existence-only and entirely immutable: Stripe exposes
 * create, retrieve and delete, but no update endpoint. Changing either
 * `valueListId` or `value` therefore replaces the item.
 *
 * Items carry no `metadata` field, so alchemy cannot brand them the way it
 * brands other Stripe objects. Identity is instead the natural
 * `(valueListId, value)` pair — which is what `read` matches on to
 * re-discover an item after state loss, and what makes create idempotent.
 *
 * Requires Radar to be enabled on the Stripe account.
 *
 * ### Adding a value to a list
 * **Example:** Block a single email address
 * ```typescript
 * const blocked = yield* Stripe.RadarValueList("blocked-emails", {
 *   alias: "blocked_emails",
 *   itemType: "email",
 * });
 *
 * yield* Stripe.RadarValueListItem("fraudster", {
 *   valueListId: blocked.valueListId,
 *   value: "fraud@example.com",
 * });
 * ```
 *
 * ### Populating a list from an array
 * **Example:** Block several IP addresses
 * ```typescript
 * const blockedIps = yield* Stripe.RadarValueList("blocked-ips", {
 *   alias: "blocked_ips",
 *   itemType: "ip_address",
 * });
 *
 * for (const ip of ["203.0.113.7", "198.51.100.42"]) {
 *   yield* Stripe.RadarValueListItem(`blocked-${ip}`, {
 *     valueListId: blockedIps.valueListId,
 *     value: ip,
 *   });
 * }
 * ```
 *
 * @see https://docs.stripe.com/api/radar/value_list_items
 *
 * @resource
 */
export const RadarValueListItem = Resource<RadarValueListItem>(
  "Stripe.RadarValueListItem",
);

export const RadarValueListItemProvider = () =>
  Provider.succeed(RadarValueListItem, {
    stables: [
      "valueListItemId",
      "valueListId",
      "value",
      "createdBy",
      "created",
      "livemode",
    ],
    list: Effect.fn(function* () {
      // Items are only enumerable per parent list, so account-wide
      // enumeration walks the value lists first.
      const valueLists = yield* listAllValueListIds;
      const perList = yield* Effect.forEach(
        valueLists,
        (valueListId) => listAllItems(valueListId),
        { concurrency: 5 },
      );
      return perList.flat().map(toAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // Existence-only: Stripe has no update endpoint for value list items,
      // so every change to the identity pair is a replacement. The new
      // (list, value) pair always differs from the old one, so create-first
      // never collides with the outgoing item.
      if (
        news.valueListId !== output.valueListId ||
        news.value !== output.value
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (output?.valueListItemId) {
        const observed = yield* getItem(output.valueListItemId);
        if (observed !== undefined) return toAttributes(observed);
        return undefined;
      }
      // State loss: re-discover through the natural key. There is no
      // metadata to brand, so the (list, value) pair is the identity.
      const valueListId = olds?.valueListId ?? output?.valueListId;
      const value = olds?.value ?? output?.value;
      if (valueListId === undefined || value === undefined) return undefined;
      const found = yield* findItemByValue(valueListId, value);
      return found === undefined ? undefined : toAttributes(found);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      // 1. Observe — the cached id first, then the natural key (which also
      //    covers a create whose response never made it into state).
      let observed =
        output?.valueListItemId !== undefined
          ? yield* getItem(output.valueListItemId)
          : undefined;
      if (
        observed !== undefined &&
        (observed.value_list !== news.valueListId ||
          observed.value !== news.value)
      ) {
        // The cached id points at a different (list, value) pair — the diff
        // above would normally have forced a replacement, so treat the cache
        // as stale rather than mutating the wrong object.
        observed = undefined;
      }
      if (observed === undefined) {
        observed = yield* findItemByValue(news.valueListId, news.value);
      }

      // 2. Ensure — create when missing. A duplicate value in the same list
      //    is rejected by Stripe; re-resolve through the natural key instead
      //    of failing on that race.
      if (observed === undefined) {
        observed = yield* PostRadarValueListItems({
          value_list: news.valueListId,
          value: news.value,
        }).pipe(
          Effect.catchTag("InvalidRequestError", (error) =>
            findItemByValue(news.valueListId, news.value).pipe(
              Effect.flatMap((raced) =>
                raced === undefined
                  ? Effect.fail(error)
                  : Effect.succeed(raced),
              ),
            ),
          ),
        );
      }

      // 3. No sync step — every field is immutable.
      return toAttributes(observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* DeleteRadarValueListItemsItem({
        item: output.valueListItemId,
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (error) =>
          error.code === "resource_missing" ? Effect.void : Effect.fail(error),
        ),
        Effect.asVoid,
      );
    }),
  });

const toAttributes = (
  item: StripeValueListItem,
): RadarValueListItemAttributes => ({
  valueListItemId: item.id,
  valueListId: item.value_list,
  value: item.value,
  createdBy: item.created_by,
  created: item.created,
  livemode: item.livemode,
});

/** Retrieve an item by id, mapping "does not exist" to `undefined`. */
const getItem = (valueListItemId: string) =>
  GetRadarValueListItemsItem({ item: valueListItemId }).pipe(
    Effect.map((item): StripeValueListItem | undefined => item),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    // Stripe reports a missing object as `invalid_request_error` with code
    // `resource_missing`; distilled dispatches on `error.type` first, so it
    // never reaches the `NotFound` branch above.
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/**
 * Find an item by its exact value within a list. Stripe's `value` filter is
 * an "is like" match, so the exact comparison is re-applied client-side.
 */
const findItemByValue = (valueListId: string, value: string) =>
  Effect.gen(function* () {
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* GetRadarValueListItems({
        value_list: valueListId,
        value,
        limit: 100,
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      const exact = response.data.find((item) => item.value === value);
      if (exact !== undefined) return exact;
      const last = response.data[response.data.length - 1];
      if (!response.has_more || last === undefined) return undefined;
      startingAfter = last.id;
    }
    return undefined;
  });

/** Exhaustively enumerate every item in one value list. */
const listAllItems = (valueListId: string) =>
  Effect.gen(function* () {
    const items: StripeValueListItem[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* GetRadarValueListItems({
        value_list: valueListId,
        limit: 100,
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      items.push(...response.data);
      const last = response.data[response.data.length - 1];
      if (!response.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return items;
  });

/** Exhaustively enumerate the ids of every value list on the account. */
const listAllValueListIds = Effect.gen(function* () {
  const ids: string[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetRadarValueLists({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    ids.push(...response.data.map((list) => list.id));
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return ids;
});
