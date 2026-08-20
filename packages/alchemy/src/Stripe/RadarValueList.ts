import {
  DeleteRadarValueListsValueList,
  GetRadarValueLists,
  GetRadarValueListsValueList,
  PostRadarValueLists,
  PostRadarValueListsValueList,
  type RadarValueList as StripeValueList,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  brandMetadata,
  isOwned,
  type Metadata,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * The type of the values held by a Radar value list. Determines how Radar
 * interprets each item and which rule attributes the list can be compared
 * against.
 */
export type RadarValueListItemType =
  | "account"
  | "card_bin"
  | "card_fingerprint"
  | "case_sensitive_string"
  | "country"
  | "crypto_fingerprint"
  | "customer_id"
  | "email"
  | "ip_address"
  | "sepa_debit_fingerprint"
  | "string"
  | "us_bank_account_fingerprint";

/** Stripe's own default when `item_type` is omitted on create. */
const DEFAULT_ITEM_TYPE: RadarValueListItemType = "string";

/**
 * Value lists in Stripe are enumerated 100 at a time; the cap keeps a
 * runaway cursor from looping forever (10,000 lists is far past any real
 * account).
 */
const MAX_PAGES = 100;

export type RadarValueListProps = {
  /**
   * The alias used to reference the list from Radar rules (e.g. a list
   * aliased `blocked_emails` is written `@blocked_emails` in a rule).
   * Must be unique across the Stripe account.
   *
   * Changing the alias is applied in place, but every Radar rule that
   * references the old alias stops matching this list — update the rules in
   * the same change.
   */
  alias: string;
  /**
   * Human-readable name shown in the Stripe dashboard.
   *
   * @default - the `alias`
   */
  name?: string;
  /**
   * The type of the values held by the list. Cannot be changed after
   * creation — a change replaces the list (and therefore drops every item
   * in it).
   *
   * @default "string"
   */
  itemType?: RadarValueListItemType;
  /**
   * Arbitrary key/value pairs attached to the value list. Alchemy also
   * writes its own `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys for
   * ownership tracking; those are stripped from the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type RadarValueList = Resource<
  "Stripe.RadarValueList",
  RadarValueListProps,
  {
    /** Stripe's unique identifier for the value list (`rsl_…`). */
    valueListId: string;
    /** The alias used to reference the list from Radar rules. */
    alias: string;
    /** Human-readable name shown in the Stripe dashboard. */
    name: string;
    /** The type of the values held by the list. */
    itemType: RadarValueListItemType;
    /** User-supplied metadata (alchemy's internal keys removed). */
    metadata: Record<string, string>;
    /** The name or email address of the user who created the list. */
    createdBy: string;
    /** Creation time, in seconds since the Unix epoch. */
    created: number;
    /** `true` when the list lives in live mode rather than test mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

type RadarValueListAttributes = RadarValueList["Attributes"];

/**
 * A Stripe Radar value list — a named group of values (emails, IPs, card
 * fingerprints, …) that Radar rules can reference by alias.
 *
 * Value lists require Radar to be enabled on the Stripe account. The list
 * itself is created empty; add entries with `Stripe.RadarValueListItem`.
 *
 * Two behaviours are worth calling out. First, `itemType` is immutable:
 * changing it replaces the list (delete-first, because the alias must stay
 * unique), which discards every item it held. Second, Stripe refuses to
 * delete a value list that is still referenced by an active Radar rule — a
 * `stack.destroy()` in that situation fails with Stripe's
 * `invalid_request_error` until the referencing rule is removed in the
 * dashboard.
 *
 * ### Creating a value list
 * **Example:** Minimal value list
 * ```typescript
 * const blocked = yield* Stripe.RadarValueList("blocked-emails", {
 *   alias: "blocked_emails",
 * });
 * ```
 *
 * **Example:** Fully configured value list
 * ```typescript
 * const blocked = yield* Stripe.RadarValueList("blocked-emails", {
 *   alias: "blocked_emails",
 *   name: "Blocked customer emails",
 *   itemType: "email",
 *   metadata: { team: "risk" },
 * });
 * ```
 *
 * ### Blocking IP addresses
 * **Example:** IP address list
 * ```typescript
 * const blockedIps = yield* Stripe.RadarValueList("blocked-ips", {
 *   alias: "blocked_ips",
 *   name: "Blocked IP addresses",
 *   itemType: "ip_address",
 * });
 * ```
 *
 * ### Populating the list
 * **Example:** Add items to the list
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
 * @see https://docs.stripe.com/api/radar/value_lists
 *
 * @resource
 */
export const RadarValueList = Resource<RadarValueList>("Stripe.RadarValueList");

export const RadarValueListProvider = () =>
  Provider.succeed(RadarValueList, {
    stables: ["valueListId", "created", "createdBy", "livemode"],
    list: Effect.fn(function* () {
      const lists = yield* listAllValueLists;
      return lists.map(toAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // `item_type` is fixed at creation — the update endpoint accepts only
      // `alias`, `name` and `metadata`. The alias is unique per account, so
      // the replacement must delete the old list before creating the new one
      // or Stripe rejects the create with a duplicate-alias error.
      if ((news.itemType ?? DEFAULT_ITEM_TYPE) !== output.itemType) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.valueListId) {
        const observed = yield* getValueList(output.valueListId);
        return observed === undefined ? undefined : toAttributes(observed);
      }
      // State loss: re-discover the list through its natural key (the alias
      // is unique per account) and confirm alchemy's branding before
      // claiming it.
      const alias = olds?.alias;
      const candidates: StripeValueList[] =
        alias !== undefined
          ? yield* findValueListByAlias(alias).pipe(
              Effect.map((list) => (list === undefined ? [] : [list])),
            )
          : yield* listAllValueLists;
      for (const list of candidates) {
        if (yield* isOwned(id, toMetadata(list.metadata))) {
          return toAttributes(list);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);
      const desiredName = news.name ?? news.alias;

      // The alias is unique per account, so it doubles as a recovery key for
      // a create whose response never made it into state. Only a list
      // carrying alchemy's branding for this logical id is claimed, so a
      // pre-existing foreign list is never silently adopted.
      const findOwnedByAlias = findValueListByAlias(news.alias).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.succeed(undefined)
            : isOwned(id, toMetadata(found.metadata)).pipe(
                Effect.map((owned) => (owned ? found : undefined)),
              ),
        ),
      );

      // 1. Observe — `output` is only a cache of the id; the object may be
      //    gone (deleted out of band, or a create whose state never landed).
      let observed =
        output?.valueListId !== undefined
          ? yield* getValueList(output.valueListId)
          : undefined;
      if (observed === undefined) {
        observed = yield* findOwnedByAlias;
      }

      // 2. Ensure — create when missing. A concurrent create (or a create
      //    whose response we lost) surfaces as a duplicate-alias
      //    `invalid_request_error`; re-resolve through the alias instead of
      //    failing.
      if (observed === undefined) {
        observed = yield* PostRadarValueLists({
          alias: news.alias,
          name: desiredName,
          item_type: news.itemType ?? DEFAULT_ITEM_TYPE,
          metadata: desiredMetadata,
        }).pipe(
          Effect.catchTag("InvalidRequestError", (error) =>
            findOwnedByAlias.pipe(
              Effect.flatMap((raced) =>
                raced === undefined
                  ? Effect.fail(error)
                  : Effect.succeed(raced),
              ),
            ),
          ),
        );
      }

      // 3. Sync — diff the desired mutable surface against what Stripe
      //    actually holds and skip the call entirely when nothing drifted.
      const observedMetadata = toMetadata(observed.metadata);
      const metadataDrifted = !metadataEqual(observedMetadata, desiredMetadata);
      if (
        observed.alias !== news.alias ||
        observed.name !== desiredName ||
        metadataDrifted
      ) {
        observed = yield* PostRadarValueListsValueList({
          value_list: observed.id,
          alias: news.alias,
          name: desiredName,
          ...(metadataDrifted
            ? { metadata: metadataUpdate(observedMetadata, desiredMetadata) }
            : {}),
        });
      }

      // 4. Return the fresh attributes.
      return toAttributes(observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Stripe refuses to delete a value list that an active Radar rule
      // still references (a 400 `invalid_request_error` whose message names
      // the rule). That failure is deliberately propagated rather than
      // swallowed — silently leaving the list behind would make destroy
      // report success on a resource that still exists. Only a genuinely
      // missing list is treated as success.
      yield* DeleteRadarValueListsValueList({
        value_list: output.valueListId,
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (error) =>
          error.code === "resource_missing" ? Effect.void : Effect.fail(error),
        ),
        Effect.asVoid,
      );
    }),
  });

/**
 * Stripe types metadata values as `string | undefined`; alchemy's helpers
 * work on a dense `Record<string, string>`.
 */
const toMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Metadata =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const toAttributes = (list: StripeValueList): RadarValueListAttributes => ({
  valueListId: list.id,
  alias: list.alias,
  name: list.name,
  itemType: list.item_type,
  metadata: stripInternalMetadata(toMetadata(list.metadata)),
  createdBy: list.created_by,
  created: list.created,
  livemode: list.livemode,
});

/** Retrieve a value list by id, mapping "does not exist" to `undefined`. */
const getValueList = (valueListId: string) =>
  GetRadarValueListsValueList({ value_list: valueListId }).pipe(
    Effect.map((list): StripeValueList | undefined => list),
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
 * Look a value list up by its account-unique alias. Stripe's list endpoint
 * accepts `alias` as an exact filter.
 */
const findValueListByAlias = (alias: string) =>
  GetRadarValueLists({ alias, limit: 100 }).pipe(
    Effect.map((page) => page.data.find((list) => list.alias === alias)),
  );

/** Exhaustively enumerate every value list on the account. */
const listAllValueLists = Effect.gen(function* () {
  const lists: StripeValueList[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetRadarValueLists({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    lists.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return lists;
});
