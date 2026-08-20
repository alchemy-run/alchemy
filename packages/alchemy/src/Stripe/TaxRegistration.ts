import {
  GetTaxRegistrations,
  GetTaxRegistrationsId,
  PostTaxRegistrations,
  type PostTaxRegistrationsIdRequest,
  type PostTaxRegistrationsRequestCountryOptions,
  type TaxProductRegistrationsResourceCountryOptions,
  type TaxRegistration as StripeTaxRegistration,
  type TaxRegistrationStatus,
  PostTaxRegistrationsId,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * Per-country registration options, keyed by lowercase ISO 3166-1 alpha-2
 * country code. Re-exported straight from the Stripe API surface — the union
 * is large (one shape per supported country) and Stripe adds to it often, so
 * mirroring it beats hand-rolling a copy that immediately goes stale.
 *
 * Members use Stripe's wire (snake_case) names, e.g.
 * `{ us: { state: "CA", type: "state_sales_tax" } }`.
 */
export type TaxRegistrationCountryOptions =
  PostTaxRegistrationsRequestCountryOptions;

/**
 * The observed per-country options on a deployed registration. Structurally
 * richer than {@link TaxRegistrationCountryOptions} (Stripe echoes resolved
 * defaults back), so it is a distinct type.
 */
export type TaxRegistrationObservedCountryOptions =
  TaxProductRegistrationsResourceCountryOptions;

/**
 * When a registration starts applying: `"now"`, or a Unix timestamp in
 * seconds.
 */
export type TaxRegistrationActiveFrom = "now" | number;

/** Hard bound on list pagination so a runaway cursor can never spin. */
const MAX_LIST_PAGES = 50;

export type TaxRegistrationProps = {
  /**
   * Two-letter country code
   * ([ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2))
   * the business is registered to collect tax in.
   *
   * Cannot be changed after creation — changing it replaces the resource.
   */
  country: string;
  /**
   * Registration options specific to `country`, keyed by the lowercase
   * country code. Uses Stripe's wire names, e.g.
   * `{ us: { state: "CA", type: "state_sales_tax" } }` or
   * `{ de: { type: "standard", standard: { place_of_supply_scheme: "small_seller" } } }`.
   *
   * Cannot be changed after creation — changing it replaces the resource.
   */
  countryOptions: TaxRegistrationCountryOptions;
  /**
   * Time at which the registration starts applying: `"now"`, or a future
   * Unix timestamp in seconds. A future timestamp creates the registration
   * in the `scheduled` status.
   *
   * A registration that has already started is never re-dated by a
   * subsequent deploy — only an explicit timestamp change moves it.
   *
   * @default "now"
   */
  activeFrom?: TaxRegistrationActiveFrom;
  /**
   * Unix timestamp in seconds at which the registration stops applying. Omit
   * for a registration that is active indefinitely; clearing a previously
   * set value re-opens the registration.
   */
  expiresAt?: number;
};

export type TaxRegistration = Resource<
  "Stripe.TaxRegistration",
  TaxRegistrationProps,
  {
    /** The registration's Stripe ID (`taxreg_...`). */
    taxRegistrationId: string;
    /** Two-letter country code the registration applies to. */
    country: string;
    /** The resolved per-country options Stripe echoed back. */
    countryOptions: TaxRegistrationObservedCountryOptions;
    /** Unix timestamp (seconds) at which the registration became active. */
    activeFrom: number;
    /**
     * Unix timestamp (seconds) at which the registration stops applying, or
     * `undefined` when it applies indefinitely.
     */
    expiresAt: number | undefined;
    /**
     * `active`, `scheduled` (starts in the future) or `expired`. Derived by
     * Stripe from `activeFrom` / `expiresAt`.
     */
    status: TaxRegistrationStatus;
    /** Unix timestamp (seconds) at which the object was created. */
    created: number;
    /** `true` when the registration lives in live mode. */
    livemode: boolean;
  },
  never,
  Providers
>;

type TaxRegistrationAttributes = TaxRegistration["Attributes"];

/**
 * A Stripe Tax registration — the record telling Stripe Tax that the
 * business is registered to collect tax in a particular jurisdiction, which
 * is what turns on automatic tax calculation for that region.
 *
 * Creating this resource does **not** register the business with any tax
 * authority; it only tells Stripe about a registration that already exists.
 *
 * :::caution
 * Stripe does not support deleting a tax registration — they are permanent,
 * account-level, audit-relevant records. Destroying this resource
 * **expires** it (`expires_at: "now"`, plus `active_from: "now"` when the
 * registration was still `scheduled`) so it stops applying to new
 * transactions. The registration object itself remains on the account
 * forever and keeps showing up in list calls with `status: "expired"`.
 *
 * For the same reason, a registration whose state row is lost is **never**
 * silently re-adopted: `read` reports any matching registration as unowned
 * so the takeover has to be confirmed with `--adopt`, rather than risking a
 * duplicate permanent record.
 * :::
 *
 * ### Registering in the US
 * **Example:** California state sales tax
 * ```typescript
 * const california = yield* Stripe.TaxRegistration("california", {
 *   country: "US",
 *   countryOptions: {
 *     us: { state: "CA", type: "state_sales_tax" },
 *   },
 * });
 * ```
 *
 * ### Registering in the EU
 * **Example:** German standard registration
 * ```typescript
 * const germany = yield* Stripe.TaxRegistration("germany", {
 *   country: "DE",
 *   countryOptions: {
 *     de: {
 *       type: "standard",
 *       standard: { place_of_supply_scheme: "small_seller" },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** EU one-stop-shop (OSS) union scheme
 * ```typescript
 * const oss = yield* Stripe.TaxRegistration("eu-oss", {
 *   country: "IE",
 *   countryOptions: { ie: { type: "oss_union" } },
 * });
 * ```
 *
 * ### Scheduling and expiry
 * **Example:** A registration that starts next quarter and ends a year later
 * ```typescript
 * const scheduled = yield* Stripe.TaxRegistration("uk-2027", {
 *   country: "GB",
 *   countryOptions: { gb: { type: "standard" } },
 *   activeFrom: 1_798_761_600,
 *   expiresAt: 1_830_297_600,
 * });
 * ```
 *
 * ### Composing several jurisdictions
 * **Example:** Collect tax in three regions from one stack
 * ```typescript
 * const registrations = yield* Effect.all([
 *   Stripe.TaxRegistration("us-ca", {
 *     country: "US",
 *     countryOptions: { us: { state: "CA", type: "state_sales_tax" } },
 *   }),
 *   Stripe.TaxRegistration("us-ny", {
 *     country: "US",
 *     countryOptions: { us: { state: "NY", type: "state_sales_tax" } },
 *   }),
 *   Stripe.TaxRegistration("de", {
 *     country: "DE",
 *     countryOptions: { de: { type: "standard" } },
 *   }),
 * ]);
 * ```
 *
 * @see https://docs.stripe.com/api/tax/registrations
 *
 * @resource
 */
export const TaxRegistration = Resource<TaxRegistration>(
  "Stripe.TaxRegistration",
);

export const TaxRegistrationProvider = () =>
  Provider.succeed(TaxRegistration, {
    stables: ["taxRegistrationId", "country", "created"],
    list: Effect.fn(function* () {
      const registrations = yield* listAllRegistrations;
      return registrations.map(toAttributes);
    }),
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      // The jurisdiction itself is fixed at creation: Stripe has no API to
      // move a registration to another country or to restate its options.
      if (news.country !== (output?.country ?? olds?.country)) {
        return { action: "replace" } as const;
      }
      // `output.countryOptions` is the response shape (Stripe echoes back
      // resolved defaults), so it cannot be compared against the request
      // shape — the previously-deployed props are the only like-for-like
      // baseline. On adoption (`olds === undefined`) there is nothing to
      // compare, and we deliberately do not replace a permanent record on a
      // guess.
      if (
        olds !== undefined &&
        !canonicalEquals(news.countryOptions, olds.countryOptions)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output, olds }) {
      if (output?.taxRegistrationId) {
        const observed = yield* getRegistration(output.taxRegistrationId);
        return observed === undefined ? undefined : toAttributes(observed);
      }
      // State loss. Tax registrations carry no metadata and no natural key
      // beyond the country, so a match is only ever a guess — surface it as
      // unowned and make the operator confirm with `--adopt`. Creating a
      // duplicate permanent record would be far worse than failing loudly.
      const country = olds?.country;
      if (country === undefined) return undefined;
      const registrations = yield* listAllRegistrations;
      const match = registrations.find(
        (registration) =>
          registration.country === country && registration.status !== "expired",
      );
      return match === undefined ? undefined : Unowned(toAttributes(match));
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      // 1. Observe — `output` only caches the id.
      const observed = output?.taxRegistrationId
        ? yield* getRegistration(output.taxRegistrationId)
        : undefined;

      // 2. Ensure — create when missing.
      if (observed === undefined) {
        const created = yield* PostTaxRegistrations({
          country: news.country,
          country_options: news.countryOptions,
          active_from: news.activeFrom ?? "now",
          ...(news.expiresAt !== undefined
            ? { expires_at: news.expiresAt }
            : {}),
        });
        return toAttributes(created);
      }

      // 3. Sync — only `active_from` and `expires_at` are mutable; diff each
      //    against OBSERVED state and skip the call entirely on a no-op.
      const update: PostTaxRegistrationsIdRequest = { id: observed.id };
      let changed = false;

      // A registration Alchemy previously expired (destroy) is revived
      // rather than duplicated.
      const expired = observed.status === "expired";
      if (typeof news.activeFrom === "number") {
        if (observed.active_from !== news.activeFrom) {
          update.active_from = news.activeFrom;
          changed = true;
        }
      } else if (expired) {
        update.active_from = "now";
        changed = true;
      }
      // `"now"`/omitted never re-dates a registration that already started —
      // that would bump `active_from` on every deploy.

      const observedExpiresAt = observed.expires_at ?? undefined;
      if (news.expiresAt !== undefined) {
        if (observedExpiresAt !== news.expiresAt) {
          update.expires_at = news.expiresAt;
          changed = true;
        }
      } else if (observedExpiresAt !== undefined) {
        // Stripe unsets `expires_at` when it is posted as an empty string.
        update.expires_at = "";
        changed = true;
      }

      if (!changed) return toAttributes(observed);

      const updated = yield* PostTaxRegistrationsId(update);
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* getRegistration(output.taxRegistrationId);
      // Already gone (or never created) — deletion is idempotent.
      if (observed === undefined) return;
      // Already expired — nothing left to expire.
      if (observed.status === "expired") return;
      yield* PostTaxRegistrationsId({
        id: observed.id,
        // A registration that has not started yet cannot simply be given an
        // `expires_at` in the past; pull its start forward first.
        ...(observed.status === "scheduled"
          ? { active_from: "now" as const }
          : {}),
        expires_at: "now" as const,
      }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (error) =>
          error.code === "resource_missing" ? Effect.void : Effect.fail(error),
        ),
      );
    }),
  });

const toAttributes = (
  registration: StripeTaxRegistration,
): TaxRegistrationAttributes => ({
  taxRegistrationId: registration.id,
  country: registration.country,
  countryOptions: registration.country_options,
  activeFrom: registration.active_from,
  expiresAt: registration.expires_at ?? undefined,
  status: registration.status,
  created: registration.created,
  livemode: registration.livemode,
});

/**
 * Fetch a registration, mapping "missing" onto `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing`, which distilled dispatches by `error.type` before
 * status — so the tag is `InvalidRequestError`, not `NotFound`. Both are
 * handled until distilled types `resource_missing` as its own tag.
 */
const getRegistration = (id: string) =>
  GetTaxRegistrationsId({ id }).pipe(
    Effect.map((result): StripeTaxRegistration | undefined => result),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/**
 * Enumerate every tax registration on the account, in every status. Stripe
 * pages with a `starting_after` cursor plus a `has_more` flag; the page count
 * is hard-bounded so a misbehaving cursor can never spin forever.
 */
const listAllRegistrations = Effect.gen(function* () {
  const registrations: StripeTaxRegistration[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const response = yield* GetTaxRegistrations({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    registrations.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return registrations;
});

/**
 * Deep structural equality over the country-options tree, insensitive to key
 * order. Country options are plain JSON (strings, numbers, booleans and
 * nested objects), so a canonical serialization is both sufficient and
 * cheaper than a recursive comparator.
 */
const canonicalEquals = (a: unknown, b: unknown): boolean =>
  canonicalize(a) === canonicalize(b);

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
};
