import {
  GetTaxSettings,
  PostTaxSettings,
  type PostTaxSettingsRequest,
  type TaxSettings as StripeTaxSettings,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * Whether a price is considered to already include tax (`inclusive`), to have
 * tax added on top (`exclusive`), or to be inferred from the price's currency
 * (`inferred_by_currency`).
 */
export type TaxBehavior = "exclusive" | "inclusive" | "inferred_by_currency";

/** The tax calculation engine the account uses. */
export type TaxCalculationProvider = "anrok" | "avalara" | "sphere" | "stripe";

/**
 * `active` once Stripe has everything it needs to calculate tax; `pending`
 * while required fields (typically the head office address) are missing.
 */
export type TaxSettingsStatus = "active" | "pending";

/**
 * A postal address, with every component optional. Components you leave
 * `undefined` are explicitly blanked on Stripe, so the declared address is
 * always exactly what the account ends up with.
 */
export type TaxAddress = {
  /** Address line 1, such as the street, PO Box, or company name. */
  line1?: string;
  /** Address line 2, such as the apartment, suite, unit, or building. */
  line2?: string;
  /** City, district, suburb, town, or village. */
  city?: string;
  /**
   * State/province as an ISO 3166-2 subdivision code, without the country
   * prefix — e.g. `"CA"` or `"NY"`.
   */
  state?: string;
  /** ZIP or postal code. */
  postalCode?: string;
  /** Two-letter ISO 3166-1 alpha-2 country code, e.g. `"US"`. */
  country?: string;
};

/** Default tax configuration applied to Stripe Tax calculations. */
export type TaxSettingsDefaults = {
  /**
   * A [tax code](https://docs.stripe.com/tax/tax-categories) ID used to
   * classify products and prices that don't declare one themselves,
   * e.g. `"txcd_99999999"`.
   */
  taxCode?: string;
  /**
   * The tax behavior used when an item's price leaves it unspecified.
   *
   * Stripe treats this as **one-way**: once set it can never be returned to
   * `null`, only changed to another value. Destroying this resource
   * therefore cannot un-set it.
   */
  taxBehavior?: TaxBehavior;
};

/** The place where the business is located, for tax purposes. */
export type TaxHeadOffice = {
  /** The location of the business for tax purposes. */
  address: TaxAddress;
};

/**
 * The account's Tax Settings as they were found *before* Alchemy first wrote
 * them. Captured on the first reconcile and restored, as far as Stripe
 * permits, when the resource is destroyed.
 */
export type TaxSettingsSnapshot = {
  /** The pre-existing default tax code / behavior. */
  defaults: {
    /** The tax code the account defaulted to, if any. */
    taxCode: string | undefined;
    /** The tax behavior the account defaulted to, if any. */
    taxBehavior: TaxBehavior | undefined;
  };
  /** The pre-existing head office address, if one was configured. */
  headOffice: TaxHeadOffice | undefined;
};

/** Why the settings are still `pending`, when they are. */
export type TaxSettingsStatusDetails = {
  /**
   * The fields Stripe still needs before it can calculate tax. Includes
   * `head_office` while no head office address is configured. Empty once the
   * settings are `active`.
   */
  missingFields: string[];
};

export type TaxSettingsProps = {
  /**
   * Default configuration used by Stripe Tax calculations.
   *
   * Fields you omit are left at their current values — Stripe exposes no way
   * to un-set `tax_code` or `tax_behavior` once either has been written.
   */
  defaults?: TaxSettingsDefaults;
  /**
   * The place where the business is located. Stripe Tax cannot calculate
   * anything until this is set, so the settings stay `pending` (with
   * `head_office` listed in `statusDetails.missingFields`) until it is.
   */
  headOffice?: TaxHeadOffice;
};

export type TaxSettings = Resource<
  "Stripe.TaxSettings",
  TaxSettingsProps,
  {
    /**
     * Synthetic, constant identifier — `"tax_settings"`.
     *
     * The Stripe Tax Settings object is an account-level singleton and
     * carries **no `id`** of its own (the response has only `object`,
     * `defaults`, `head_office`, `status`, `status_details` and `livemode`),
     * and no account id either. A constant keeps the attribute stable across
     * every reconcile, which is exactly what a singleton needs: there is
     * never a second instance for it to disambiguate.
     */
    taxSettingsId: string;
    /**
     * `active` once Stripe can calculate tax for the account, `pending` while
     * required configuration is still missing.
     */
    status: TaxSettingsStatus;
    /** Detail on why the settings are still `pending`, when they are. */
    statusDetails: TaxSettingsStatusDetails;
    /** The observed default tax configuration. */
    defaults: {
      /** The tax calculation engine in use. Defaults to `stripe`. */
      provider: TaxCalculationProvider;
      /** The default tax code, if one is configured. */
      taxCode: string | undefined;
      /** The default tax behavior, if one is configured. */
      taxBehavior: TaxBehavior | undefined;
    };
    /** The observed head office address, if one is configured. */
    headOffice: TaxHeadOffice | undefined;
    /** `true` when these are the live-mode settings rather than test mode. */
    livemode: boolean;
    /**
     * The settings the account had before Alchemy first wrote them. Restored
     * on destroy, so tearing the stack down puts the account back the way it
     * was found (subject to Stripe's one-way `tax_behavior` rule).
     */
    previousSettings: TaxSettingsSnapshot;
  },
  never,
  Providers
>;

type TaxSettingsAttributes = TaxSettings["Attributes"];

/**
 * The **account-level Stripe Tax Settings singleton** — the default tax code
 * and tax behavior applied to Stripe Tax calculations, plus the head office
 * address Stripe calculates from.
 *
 * :::caution
 * This resource mutates **account-wide** configuration. There is exactly one
 * Tax Settings object per Stripe account, shared by every stack, every stage,
 * and every other integration pointed at the same account. Deploying it in
 * `dev` changes the same object `prod` reads. Deploy it from exactly one
 * stack, and expect a second stack that also declares it to fight over the
 * same values.
 * :::
 *
 * The object **always exists** and can never be created or deleted, only
 * updated. Alchemy therefore models it as a capture-and-restore singleton:
 *
 * - The first reconcile snapshots the account's pre-existing settings into
 *   `previousSettings` before writing anything.
 * - Subsequent reconciles converge only the fields you declare, diffing them
 *   against the **observed** Stripe state and skipping the API call entirely
 *   on a no-op.
 * - Destroying the resource posts `previousSettings` back rather than
 *   deleting anything, and is idempotent — a second destroy against
 *   already-restored settings is a no-op.
 *
 * Two Stripe rules constrain that restore, and neither has a workaround:
 *
 * - **`defaults.taxBehavior` is one-way.** Stripe documents that once
 *   specified it cannot be changed back to `null`. If the account had no
 *   default tax behavior before, destroy leaves the one you set in place.
 * - **`defaults.taxCode` and `headOffice` cannot be un-set** either. If the
 *   account had none before, destroy leaves yours in place. Where a previous
 *   value *did* exist, it is restored exactly.
 *
 * There is also no `metadata` field on this object, so Alchemy cannot brand
 * it the way it brands other Stripe resources. Ownership is positional: the
 * singleton is whatever `GET /v1/tax/settings` returns for the credentialed
 * account.
 *
 * ### Configuring Stripe Tax
 * **Example:** Set the head office so Stripe Tax can calculate
 * ```typescript
 * const tax = yield* Stripe.TaxSettings("TaxSettings", {
 *   headOffice: {
 *     address: {
 *       line1: "354 Oyster Point Blvd",
 *       city: "South San Francisco",
 *       state: "CA",
 *       postalCode: "94080",
 *       country: "US",
 *     },
 *   },
 * });
 * return { taxStatus: tax.status };
 * ```
 *
 * **Example:** Fully configured — defaults plus head office
 * ```typescript
 * const tax = yield* Stripe.TaxSettings("TaxSettings", {
 *   defaults: {
 *     taxCode: "txcd_99999999",
 *     taxBehavior: "exclusive",
 *   },
 *   headOffice: {
 *     address: {
 *       line1: "1 Grafton Street",
 *       line2: "Floor 3",
 *       city: "Dublin",
 *       postalCode: "D02 X275",
 *       country: "IE",
 *     },
 *   },
 * });
 * ```
 *
 * ### Composing with billing resources
 * **Example:** Give products the account-wide default tax code
 * ```typescript
 * const tax = yield* Stripe.TaxSettings("TaxSettings", {
 *   defaults: { taxCode: "txcd_10000000", taxBehavior: "exclusive" },
 *   headOffice: {
 *     address: { city: "Seattle", state: "WA", postalCode: "98101", country: "US" },
 *   },
 * });
 *
 * // The product inherits `defaults.taxCode` when it declares none of its own.
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro" });
 * return { taxStatus: tax.status, productId: product.productId };
 * ```
 *
 * ### Checking readiness
 * **Example:** Surface what Stripe is still missing
 * ```typescript
 * const tax = yield* Stripe.TaxSettings("TaxSettings", {
 *   defaults: { taxBehavior: "inclusive" },
 * });
 * return {
 *   // "pending" until a head office address is configured.
 *   status: tax.status,
 *   missingFields: tax.statusDetails.missingFields,
 * };
 * ```
 *
 * @see https://docs.stripe.com/api/tax/settings
 *
 * @resource
 */
export const TaxSettings = Resource<TaxSettings>("Stripe.TaxSettings");

/**
 * The Tax Settings object has no Stripe id — this constant stands in for one
 * so the resource has a stable primary identifier.
 */
export const TAX_SETTINGS_ID = "tax_settings";

export const TaxSettingsProvider = () =>
  Provider.succeed(TaxSettings, {
    /**
     * Account singleton: it can't be deleted, only restored, so
     * `alchemy unsafe nuke` must not treat it as a discrete resource to
     * remove — `list` always returns it and nuke would otherwise loop
     * reporting "deleted but still there".
     */
    nuke: { singleton: true },
    stables: ["taxSettingsId", "previousSettings", "livemode"],

    /**
     * There is no enumeration API — the settings object always exists for the
     * credentialed account. Mirror `read`: observe the one instance and hand
     * it back as a single-element array. Nothing is being managed from this
     * angle, so the observed snapshot is its own restore target.
     */
    list: Effect.fn(function* () {
      const observed = yield* GetTaxSettings({});
      return [taxSettingsAttributes(observed, snapshotOf(observed))];
    }),

    /**
     * Nothing about this resource is replaceable: there is exactly one
     * settings object per account and it can never be recreated. Return
     * `undefined` unconditionally so the engine plans its default update.
     */
    diff: Effect.fn(function* ({ news }) {
      // `news` is `Input<Props>` during plan — never touch it unresolved.
      if (!isResolved(news)) return undefined;
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const observed = yield* GetTaxSettings({});
      // The singleton always exists and carries no ownership marker, so a
      // cold read adopts freely; whatever it looked like at adoption time
      // becomes the restore target.
      const previousSettings = output?.previousSettings ?? snapshotOf(observed);
      return taxSettingsAttributes(observed, previousSettings);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // 1. Observe — the singleton always exists; read its live state.
      const observed = yield* GetTaxSettings({});

      // 2. Capture — the pre-management snapshot, restored on destroy. Taken
      //    only on the first reconcile; later runs carry it forward.
      const previousSettings = output?.previousSettings ?? snapshotOf(observed);

      // 3. Sync — diff each declared aspect against the OBSERVED state and
      //    post only the delta. Undeclared fields are left alone: Stripe
      //    offers no way to un-set a tax code, tax behavior or head office.
      const update = updateFor(news, observed);
      if (update === undefined) {
        return taxSettingsAttributes(observed, previousSettings);
      }
      const settings = yield* PostTaxSettings(update);

      // 4. Return — the POST echoes the full settings object back.
      return taxSettingsAttributes(settings, previousSettings);
    }),

    /**
     * Restores the captured snapshot rather than deleting anything — the Tax
     * Settings object cannot be deleted. Idempotent: settings that already
     * match the snapshot skip the API call entirely, so a re-run after a
     * crashed destroy is a no-op.
     *
     * Values the account did **not** have before are left in place, because
     * Stripe has no un-set for them (and documents `tax_behavior` in
     * particular as impossible to return to `null`).
     */
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* GetTaxSettings({});
      const update = restoreFor(output.previousSettings, observed);
      if (update === undefined) return;
      yield* PostTaxSettings(update);
    }),
  });

/** Map Stripe's null-heavy address onto the `undefined`-based prop shape. */
const normalizeAddress = (
  headOffice: StripeTaxSettings["head_office"],
): TaxHeadOffice | undefined => {
  if (headOffice == null) return undefined;
  const address = headOffice.address;
  const normalized: TaxAddress = {};
  if (address.line1 != null) normalized.line1 = address.line1;
  if (address.line2 != null) normalized.line2 = address.line2;
  if (address.city != null) normalized.city = address.city;
  if (address.state != null) normalized.state = address.state;
  if (address.postal_code != null) normalized.postalCode = address.postal_code;
  if (address.country != null) normalized.country = address.country;
  // Stripe returns `head_office: { address: { …all null } }` for an account
  // that has never set one — that is "no head office", not an empty address.
  if (Object.keys(normalized).length === 0) return undefined;
  return { address: normalized };
};

/** Snapshot the restorable parts of an observed settings object. */
const snapshotOf = (settings: StripeTaxSettings): TaxSettingsSnapshot => ({
  defaults: {
    taxCode: settings.defaults.tax_code ?? undefined,
    taxBehavior: (settings.defaults.tax_behavior ?? undefined) as
      | TaxBehavior
      | undefined,
  },
  headOffice: normalizeAddress(settings.head_office),
});

/** Map an observed settings object onto this resource's Attributes shape. */
const taxSettingsAttributes = (
  settings: StripeTaxSettings,
  previousSettings: TaxSettingsSnapshot,
): TaxSettingsAttributes => ({
  taxSettingsId: TAX_SETTINGS_ID,
  status: settings.status as TaxSettingsStatus,
  statusDetails: {
    missingFields: [...(settings.status_details.pending?.missing_fields ?? [])],
  },
  defaults: {
    provider: settings.defaults.provider as TaxCalculationProvider,
    taxCode: settings.defaults.tax_code ?? undefined,
    taxBehavior: (settings.defaults.tax_behavior ?? undefined) as
      | TaxBehavior
      | undefined,
  },
  headOffice: normalizeAddress(settings.head_office),
  livemode: settings.livemode,
  previousSettings,
});

const ADDRESS_FIELDS = [
  "line1",
  "line2",
  "city",
  "state",
  "postalCode",
  "country",
] as const;

/** Structural equality over two (possibly absent) addresses. */
const addressEqual = (
  a: TaxHeadOffice | undefined,
  b: TaxHeadOffice | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return ADDRESS_FIELDS.every(
    (field) => (a.address[field] ?? "") === (b.address[field] ?? ""),
  );
};

/**
 * Render an address as the full six-field wire payload, blanking components
 * the declaration omits. Stripe unsets a string param when it receives an
 * empty string, so posting all six makes the declared address authoritative
 * rather than merging it into whatever is already there.
 */
const addressPayload = (headOffice: TaxHeadOffice) => ({
  address: {
    line1: headOffice.address.line1 ?? "",
    line2: headOffice.address.line2 ?? "",
    city: headOffice.address.city ?? "",
    state: headOffice.address.state ?? "",
    postal_code: headOffice.address.postalCode ?? "",
    country: headOffice.address.country ?? "",
  },
});

/**
 * Build the minimal `POST /v1/tax/settings` body converging `observed` to
 * `news`, or `undefined` when everything already matches.
 */
const updateFor = (
  news: TaxSettingsProps,
  observed: StripeTaxSettings,
): PostTaxSettingsRequest | undefined => {
  const defaults: { tax_code?: string; tax_behavior?: TaxBehavior } = {};
  if (
    news.defaults?.taxCode !== undefined &&
    news.defaults.taxCode !== (observed.defaults.tax_code ?? undefined)
  ) {
    defaults.tax_code = news.defaults.taxCode;
  }
  if (
    news.defaults?.taxBehavior !== undefined &&
    news.defaults.taxBehavior !== (observed.defaults.tax_behavior ?? undefined)
  ) {
    defaults.tax_behavior = news.defaults.taxBehavior;
  }

  const observedHeadOffice = normalizeAddress(observed.head_office);
  const headOffice =
    news.headOffice !== undefined &&
    !addressEqual(news.headOffice, observedHeadOffice)
      ? news.headOffice
      : undefined;

  if (Object.keys(defaults).length === 0 && headOffice === undefined) {
    return undefined;
  }
  return {
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    ...(headOffice !== undefined
      ? { head_office: addressPayload(headOffice) }
      : {}),
  };
};

/**
 * Build the minimal `POST /v1/tax/settings` body putting `observed` back to
 * the captured `previous` snapshot, or `undefined` when the account already
 * matches it.
 *
 * Only fields that previously *had* a value are restored: Stripe cannot
 * un-set a tax code, a tax behavior (documented as one-way) or a head
 * office, so an account that had none keeps whatever this resource wrote.
 */
const restoreFor = (
  previous: TaxSettingsSnapshot,
  observed: StripeTaxSettings,
): PostTaxSettingsRequest | undefined => {
  const defaults: { tax_code?: string; tax_behavior?: TaxBehavior } = {};
  if (
    previous.defaults.taxCode !== undefined &&
    previous.defaults.taxCode !== (observed.defaults.tax_code ?? undefined)
  ) {
    defaults.tax_code = previous.defaults.taxCode;
  }
  if (
    previous.defaults.taxBehavior !== undefined &&
    previous.defaults.taxBehavior !==
      (observed.defaults.tax_behavior ?? undefined)
  ) {
    defaults.tax_behavior = previous.defaults.taxBehavior;
  }

  const observedHeadOffice = normalizeAddress(observed.head_office);
  const headOffice =
    previous.headOffice !== undefined &&
    !addressEqual(previous.headOffice, observedHeadOffice)
      ? previous.headOffice
      : undefined;

  if (Object.keys(defaults).length === 0 && headOffice === undefined) {
    return undefined;
  }
  return {
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    ...(headOffice !== undefined
      ? { head_office: addressPayload(headOffice) }
      : {}),
  };
};
