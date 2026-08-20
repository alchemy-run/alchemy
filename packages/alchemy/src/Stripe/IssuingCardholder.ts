import {
  GetIssuingCardholders,
  GetIssuingCardholdersCardholder,
  type IssuingCardholder as StripeCardholder,
  PostIssuingCardholders,
  PostIssuingCardholdersCardholder,
  type PostIssuingCardholdersCardholderRequest,
  type PostIssuingCardholdersRequestSpendingControlsAllowedCategoriesItem,
  type PostIssuingCardholdersRequestSpendingControlsSpendingLimitsItemInterval,
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
 * A merchant category an Issuing spending control can allow or block. The
 * literal union mirrors Stripe's `merchant_data.category` enum; any other
 * string is still accepted so a newly-added category never breaks the build.
 */
export type IssuingMerchantCategory =
  | PostIssuingCardholdersRequestSpendingControlsAllowedCategoriesItem
  | (string & {});

/** Interval (or event) a spending limit's amount applies to. */
export type IssuingSpendingInterval =
  | PostIssuingCardholdersRequestSpendingControlsSpendingLimitsItemInterval
  | (string & {});

/** Whether the physical card was present at the point of sale. */
export type IssuingCardPresence = "present" | "not_present" | (string & {});

/** An amount-based spending rule. */
export type IssuingSpendingLimit = {
  /** Maximum amount allowed to spend per interval, in the smallest currency unit. */
  amount: number;
  /** Interval (or event) the {@link IssuingSpendingLimit.amount} applies to. */
  interval: IssuingSpendingInterval;
  /**
   * Merchant categories this limit applies to. Omit to apply the limit to
   * every category.
   */
  categories?: IssuingMerchantCategory[];
};

/**
 * Rules that control spending. Attached to a cardholder they apply across
 * every card that cardholder owns; attached to a card they apply to that
 * card only.
 */
export type IssuingSpendingControls = {
  /**
   * Card presence statuses authorizations are allowed from. Cannot be
   * combined with {@link IssuingSpendingControls.blockedCardPresences}.
   */
  allowedCardPresences?: IssuingCardPresence[];
  /**
   * Merchant categories to allow — every other category is blocked. Cannot
   * be combined with {@link IssuingSpendingControls.blockedCategories}.
   */
  allowedCategories?: IssuingMerchantCategory[];
  /**
   * ISO 3166 alpha-2 country codes authorizations are allowed from. Cannot
   * be combined with
   * {@link IssuingSpendingControls.blockedMerchantCountries}.
   */
  allowedMerchantCountries?: string[];
  /**
   * Card presence statuses authorizations are declined from. Cannot be
   * combined with {@link IssuingSpendingControls.allowedCardPresences}.
   */
  blockedCardPresences?: IssuingCardPresence[];
  /**
   * Merchant categories to decline — every other category is allowed.
   * Cannot be combined with
   * {@link IssuingSpendingControls.allowedCategories}.
   */
  blockedCategories?: IssuingMerchantCategory[];
  /**
   * ISO 3166 alpha-2 country codes authorizations are declined from. Cannot
   * be combined with
   * {@link IssuingSpendingControls.allowedMerchantCountries}.
   */
  blockedMerchantCountries?: string[];
  /** Amount-based spending rules. */
  spendingLimits?: IssuingSpendingLimit[];
  /**
   * Currency of the amounts in
   * {@link IssuingSpendingControls.spendingLimits}. Defaults to your
   * merchant country's currency. Only settable on a cardholder — a card's
   * spending limits are always denominated in the card's own currency.
   */
  spendingLimitsCurrency?: string;
};

/** A postal address as Stripe requires it on input. */
export type IssuingAddress = {
  /** City, district, suburb, town, or village. */
  city: string;
  /** Two-letter ISO 3166-1 alpha-2 country code. */
  country: string;
  /** Address line 1 — street, PO Box, or company name. */
  line1: string;
  /** Address line 2 — apartment, suite, unit, or building. */
  line2?: string;
  /** ZIP or postal code. */
  postalCode: string;
  /** State, county, province, or region (ISO 3166-2). */
  state?: string;
};

/**
 * A postal address exactly as Stripe echoes it back. Every component is
 * nullable on read even when it was required on write.
 */
export type IssuingObservedAddress = {
  /** City, district, suburb, town, or village. */
  city: string | undefined;
  /** Two-letter ISO 3166-1 alpha-2 country code. */
  country: string | undefined;
  /** Address line 1 — street, PO Box, or company name. */
  line1: string | undefined;
  /** Address line 2 — apartment, suite, unit, or building. */
  line2: string | undefined;
  /** ZIP or postal code. */
  postalCode: string | undefined;
  /** State, county, province, or region (ISO 3166-2). */
  state: string | undefined;
};

/** The cardholder's billing details. */
export type IssuingCardholderBilling = {
  /** The cardholder's billing address. */
  address: IssuingAddress;
};

/** One of `individual` or `company`. */
export type IssuingCardholderType = "individual" | "company";

/**
 * Whether authorizations are permitted on this cardholder's cards. `blocked`
 * is set by Stripe (never by you) when the cardholder fails verification.
 */
export type IssuingCardholderStatus = "active" | "inactive";

/**
 * Locales the 3D Secure flow and one-time password messages are delivered
 * in, ordered by preference.
 */
export type IssuingCardholderLocale =
  | "da"
  | "de"
  | "en"
  | "es"
  | "fr"
  | "it"
  | "pl"
  | "sv"
  | (string & {});

/** Date of birth. Cardholders must be older than 13 years old. */
export type IssuingCardholderDob = {
  /** Day of birth, between 1 and 31. */
  day: number;
  /** Month of birth, between 1 and 12. */
  month: number;
  /** Four-digit year of birth. */
  year: number;
};

/** Additional information about a `company` cardholder. */
export type IssuingCardholderCompany = {
  /**
   * The entity's business ID number. Write-only — Stripe never echoes it
   * back, only whether one was provided.
   */
  taxId?: string;
};

/** Government-issued ID document for an `individual` cardholder. */
export type IssuingCardholderVerification = {
  /**
   * The ID of an uploaded file (created with `purpose: "identity_document"`)
   * holding the front of the document.
   */
  front?: string;
  /**
   * The ID of an uploaded file (created with `purpose: "identity_document"`)
   * holding the back of the document.
   */
  back?: string;
};

/**
 * Cardholder acceptance of Celtic's Authorized User Terms. Required for
 * cards backed by a Celtic program.
 */
export type IssuingCardholderTermsAcceptance = {
  /** Unix timestamp marking when the cardholder accepted the terms. */
  date?: number;
  /** IP address the cardholder accepted the terms from. */
  ip?: string;
  /** User agent of the browser the cardholder accepted the terms from. */
  userAgent?: string;
};

/** Additional information about an `individual` cardholder. */
export type IssuingCardholderIndividual = {
  /** First name. Required before activating cards. */
  firstName?: string;
  /** Last name. Required before activating cards. */
  lastName?: string;
  /** Date of birth. */
  dob?: IssuingCardholderDob;
  /**
   * Government-issued ID document. Write-only — Stripe echoes back only
   * that a document exists, never the file IDs.
   */
  verification?: IssuingCardholderVerification;
  /** Acceptance of the Celtic Authorized User Terms. */
  termsAcceptance?: IssuingCardholderTermsAcceptance;
};

export type IssuingCardholderProps = {
  /**
   * The cardholder's name, printed on every card issued to them. Max 24
   * characters; no numbers or special characters.
   *
   * Stripe's update endpoint does not accept `name`, so changing it
   * **replaces** the cardholder.
   */
  name: string;
  /** The cardholder's billing address. */
  billing: IssuingCardholderBilling;
  /**
   * `individual` or `company`. Changing it **replaces** the cardholder —
   * Stripe's update endpoint does not accept `type`.
   *
   * @default inferred by Stripe from whether `individual` or `company` is set
   */
  type?: IssuingCardholderType;
  /** The cardholder's email address. */
  email?: string;
  /**
   * The cardholder's phone number, normalized to E.164. Required for
   * cardholders who will hold EU cards (3D Secure one-time passwords).
   */
  phoneNumber?: string;
  /** Additional information about a `company` cardholder. */
  company?: IssuingCardholderCompany;
  /** Additional information about an `individual` cardholder. */
  individual?: IssuingCardholderIndividual;
  /** Rules that control spending across every card this cardholder owns. */
  spendingControls?: IssuingSpendingControls;
  /**
   * Whether authorizations are permitted on this cardholder's cards.
   *
   * @default "active"
   */
  status?: IssuingCardholderStatus;
  /**
   * The cardholder's preferred locales, ordered by preference. Changes the
   * language of the 3D Secure flow and one-time password messages.
   */
  preferredLocales?: IssuingCardholderLocale[];
  /**
   * Arbitrary key/value pairs stored on the cardholder. Alchemy adds its own
   * reserved `alchemy_stack` / `alchemy_stage` / `alchemy_id` entries for
   * ownership tracking; they are stripped from the `metadata` attribute.
   */
  metadata?: Metadata;
};

export type IssuingCardholder = Resource<
  "Stripe.IssuingCardholder",
  IssuingCardholderProps,
  {
    /** The Stripe cardholder ID, e.g. `ich_1MsKAB2eZvKYlo2C3eZ2eZ2e`. */
    cardholderId: string;
    /** The cardholder's name, printed on their cards. */
    name: string;
    /** The cardholder's email address, if one was set. */
    email: string | undefined;
    /** The cardholder's phone number in E.164, if one was set. */
    phoneNumber: string | undefined;
    /** `individual` or `company`. */
    type: IssuingCardholderType;
    /**
     * Whether authorizations are permitted. `blocked` is set by Stripe when
     * the cardholder fails verification and cannot be set through props.
     */
    status: "active" | "inactive" | "blocked";
    /** The cardholder's billing address as Stripe stored it. */
    billingAddress: IssuingObservedAddress;
    /** The cardholder's preferred locales, if any were set. */
    preferredLocales: IssuingCardholderLocale[] | undefined;
    /** Spending controls as Stripe stored them. */
    spendingControls: IssuingSpendingControls | undefined;
    /**
     * Whether a company tax ID was provided. Stripe never echoes the tax ID
     * itself.
     */
    companyTaxIdProvided: boolean | undefined;
    /** The individual's first name, if this is an `individual` cardholder. */
    individualFirstName: string | undefined;
    /** The individual's last name, if this is an `individual` cardholder. */
    individualLastName: string | undefined;
    /**
     * Why Stripe disabled the cardholder, if it did. While set, every card
     * declines with `cardholder_verification_required`.
     */
    requirementsDisabledReason: string | undefined;
    /** Fields that must be collected to verify and re-enable the cardholder. */
    requirementsPastDue: string[];
    /** User-supplied metadata, with alchemy's reserved keys stripped out. */
    metadata: Metadata;
    /** Whether the cardholder exists in live mode. */
    livemode: boolean;
    /** Unix timestamp of when the cardholder was created. */
    createdAt: number;
  },
  never,
  Providers
>;

type IssuingCardholderAttributes = IssuingCardholder["Attributes"];

/**
 * A Stripe Issuing cardholder — the individual or business entity that
 * {@link IssuingCard}s are issued to. Spending controls set here apply
 * across every card the cardholder owns.
 *
 * :::caution
 * Stripe does not support deleting a cardholder. Destroying this resource
 * sets `status: "inactive"`, which stops authorizations on all of their
 * cards; the cardholder remains visible in the dashboard and in list calls
 * forever.
 * :::
 *
 * Issuing must be enabled on the Stripe account before any of these calls
 * succeed.
 *
 * ### Creating a cardholder
 * **Example:** Individual cardholder
 * ```typescript
 * const cardholder = yield* Stripe.IssuingCardholder("engineer", {
 *   name: "Ada Lovelace",
 *   billing: {
 *     address: {
 *       line1: "1 Analytical Engine Way",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94103",
 *       country: "US",
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Company cardholder with spending controls
 * ```typescript
 * const cardholder = yield* Stripe.IssuingCardholder("ops-team", {
 *   name: "Acme Operations",
 *   type: "company",
 *   email: "ops@example.com",
 *   phoneNumber: "+15555550123",
 *   company: { taxId: "000000000" },
 *   preferredLocales: ["en"],
 *   status: "active",
 *   billing: {
 *     address: {
 *       line1: "500 Market St",
 *       line2: "Floor 4",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94105",
 *       country: "US",
 *     },
 *   },
 *   spendingControls: {
 *     allowedCategories: ["computer_software_stores", "computer_network_services"],
 *     spendingLimits: [{ amount: 500_000, interval: "monthly" }],
 *     spendingLimitsCurrency: "usd",
 *   },
 *   metadata: { team: "platform" },
 * });
 * ```
 *
 * ### Issuing a card to the cardholder
 * **Example:** Virtual card for a cardholder
 * ```typescript
 * const cardholder = yield* Stripe.IssuingCardholder("engineer", {
 *   name: "Ada Lovelace",
 *   billing: { address: { line1: "1 Analytical Engine Way", city: "San Francisco", state: "CA", postalCode: "94103", country: "US" } },
 * });
 *
 * const card = yield* Stripe.IssuingCard("engineer-card", {
 *   cardholderId: cardholder.cardholderId,
 *   currency: "usd",
 *   type: "virtual",
 *   status: "active",
 * });
 * ```
 *
 * ### Deactivating a cardholder
 * **Example:** Suspend authorizations without destroying the stack
 * ```typescript
 * const cardholder = yield* Stripe.IssuingCardholder("contractor", {
 *   name: "Grace Hopper",
 *   status: "inactive",
 *   billing: { address: { line1: "1 Navy Yard", city: "Washington", state: "DC", postalCode: "20003", country: "US" } },
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/issuing/cardholders
 *
 * @resource
 */
export const IssuingCardholder = Resource<IssuingCardholder>(
  "Stripe.IssuingCardholder",
);

export const IssuingCardholderProvider = () =>
  Provider.succeed(IssuingCardholder, {
    stables: ["cardholderId", "name", "type", "createdAt", "livemode"],
    // A cardholder can never be deleted — `delete` only deactivates it — so
    // account-wide teardown skips the type rather than looping forever on
    // "deleted but still there".
    nuke: { skip: true },
    list: Effect.fn(function* () {
      const cardholders = yield* listAllCardholders;
      return cardholders.map(toCardholderAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // Stripe's update endpoint accepts neither `name` nor `type`, so both
      // are immutable and force a replacement. Every other prop is patched
      // in place by `reconcile`.
      if (news.name !== output.name) return { action: "replace" } as const;
      if (news.type !== undefined && news.type !== output.type) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output }) {
      if (output?.cardholderId) {
        const observed = yield* getCardholder(output.cardholderId);
        return observed === undefined
          ? undefined
          : toCardholderAttributes(observed);
      }
      // State loss: Stripe has no tags and no name-based lookup for
      // cardholders, so re-discover ours by scanning the collection for
      // alchemy's metadata branding.
      const cardholders = yield* listAllCardholders;
      for (const cardholder of cardholders) {
        if (yield* isOwned(id, toMetadata(cardholder.metadata))) {
          return toCardholderAttributes(cardholder);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output` is only a cache of the id; the cardholder may
      //    have been removed out of band.
      const observed = output?.cardholderId
        ? yield* getCardholder(output.cardholderId)
        : undefined;

      // 2. Ensure — create when nothing is there.
      if (observed === undefined) {
        const created = yield* PostIssuingCardholders({
          name: news.name,
          billing: { address: toRequestAddress(news.billing.address) },
          ...(news.type !== undefined ? { type: news.type } : {}),
          ...(news.email !== undefined ? { email: news.email } : {}),
          ...(news.phoneNumber !== undefined
            ? { phone_number: news.phoneNumber }
            : {}),
          ...(news.company !== undefined
            ? { company: toRequestCompany(news.company) }
            : {}),
          ...(news.individual !== undefined
            ? { individual: toRequestIndividual(news.individual) }
            : {}),
          ...(news.spendingControls !== undefined
            ? {
                spending_controls: toRequestSpendingControls(
                  news.spendingControls,
                ),
              }
            : {}),
          ...(news.status !== undefined ? { status: news.status } : {}),
          ...(news.preferredLocales !== undefined
            ? { preferred_locales: news.preferredLocales }
            : {}),
          metadata: desiredMetadata,
        });
        return toCardholderAttributes(created);
      }

      // 3. Sync — diff each mutable aspect against OBSERVED state and send
      //    only the delta. An empty payload skips the API call entirely.
      const update: Omit<
        PostIssuingCardholdersCardholderRequest,
        "cardholder"
      > = {};

      if (
        news.email !== undefined &&
        news.email !== (observed.email ?? undefined)
      ) {
        update.email = news.email;
      }
      if (
        news.phoneNumber !== undefined &&
        news.phoneNumber !== (observed.phone_number ?? undefined)
      ) {
        update.phone_number = news.phoneNumber;
      }
      const desiredStatus = news.status ?? "active";
      // `blocked` is Stripe's own verdict — never try to patch away from it.
      if (observed.status !== "blocked" && desiredStatus !== observed.status) {
        update.status = desiredStatus;
      }
      const desiredAddress = toRequestAddress(news.billing.address);
      if (
        !deepEqual(
          desiredAddress,
          toRequestAddress(toObservedAddress(observed.billing.address)),
        )
      ) {
        update.billing = { address: desiredAddress };
      }
      if (news.preferredLocales !== undefined) {
        const observedLocales = observed.preferred_locales ?? undefined;
        if (
          !deepEqual(
            [...news.preferredLocales],
            observedLocales === undefined ? undefined : [...observedLocales],
          )
        ) {
          update.preferred_locales = news.preferredLocales;
        }
      }
      if (news.spendingControls !== undefined) {
        const desiredControls = toRequestSpendingControls(
          news.spendingControls,
        );
        const observedControls = toObservedSpendingControlsRequest(
          observed.spending_controls,
        );
        if (!deepEqual(desiredControls, observedControls)) {
          update.spending_controls = desiredControls;
        }
      }
      if (news.company !== undefined) {
        // `tax_id` is write-only: Stripe reports only `tax_id_provided`. Send
        // it when the account doesn't have one yet, or when the previously
        // deployed props carried a different value (`olds` is the only hint
        // available for a field the API refuses to echo).
        const taxIdChanged = news.company.taxId !== olds?.company?.taxId;
        const taxIdMissing =
          news.company.taxId !== undefined &&
          observed.company?.tax_id_provided !== true;
        if (taxIdChanged || taxIdMissing) {
          update.company = toRequestCompany(news.company);
        }
      }
      if (news.individual !== undefined) {
        const echoed = {
          firstName: news.individual.firstName,
          lastName: news.individual.lastName,
          dob: news.individual.dob,
        };
        const observedEcho = {
          firstName: observed.individual?.first_name ?? undefined,
          lastName: observed.individual?.last_name ?? undefined,
          dob: toDob(observed.individual?.dob),
        };
        // `verification` and `termsAcceptance` are write-only file/consent
        // references Stripe never echoes; fall back to `olds` for those.
        const writeOnlyChanged =
          !deepEqual(
            news.individual.verification,
            olds?.individual?.verification,
          ) ||
          !deepEqual(
            news.individual.termsAcceptance,
            olds?.individual?.termsAcceptance,
          );
        if (!deepEqual(echoed, observedEcho) || writeOnlyChanged) {
          update.individual = toRequestIndividual(news.individual);
        }
      }
      const observedMetadata = toMetadata(observed.metadata);
      if (!metadataEqual(observedMetadata, desiredMetadata)) {
        update.metadata = metadataUpdate(observedMetadata, desiredMetadata);
      }

      if (Object.keys(update).length === 0) {
        return toCardholderAttributes(observed);
      }
      const updated = yield* PostIssuingCardholdersCardholder({
        cardholder: observed.id,
        ...update,
      });
      return toCardholderAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Stripe has no cardholder delete endpoint. Deactivating is the closest
      // approximation and must be idempotent: an already-inactive (or
      // already-vanished) cardholder is a success, not an error.
      const observed = yield* getCardholder(output.cardholderId);
      if (observed === undefined) return;
      if (observed.status === "inactive") return;
      yield* PostIssuingCardholdersCardholder({
        cardholder: output.cardholderId,
        status: "inactive",
      });
    }),
  });

/** Stripe's list pages are capped at 100; never scan more than 10k objects. */
const MAX_PAGES = 100;

/**
 * Retrieve a cardholder, mapping "it isn't there" onto `undefined`.
 *
 * Stripe dispatches a missing object as `invalid_request_error` with HTTP
 * 404, and distilled matches on `error.type` before status — so the miss can
 * surface as either `NotFound` or `InvalidRequestError` with
 * `code: "resource_missing"`. Both are handled.
 */
const getCardholder = (cardholderId: string) =>
  GetIssuingCardholdersCardholder({ cardholder: cardholderId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/** Exhaustively enumerate every cardholder on the account, bounded. */
const listAllCardholders = Effect.gen(function* () {
  const cardholders: StripeCardholder[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetIssuingCardholders({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    cardholders.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return cardholders;
});

const toCardholderAttributes = (
  cardholder: StripeCardholder,
): IssuingCardholderAttributes => ({
  cardholderId: cardholder.id,
  name: cardholder.name,
  email: cardholder.email ?? undefined,
  phoneNumber: cardholder.phone_number ?? undefined,
  type: cardholder.type,
  status: cardholder.status,
  billingAddress: toObservedAddress(cardholder.billing.address),
  preferredLocales:
    cardholder.preferred_locales === null
      ? undefined
      : [...cardholder.preferred_locales],
  spendingControls: toSpendingControls(cardholder.spending_controls),
  companyTaxIdProvided: cardholder.company?.tax_id_provided ?? undefined,
  individualFirstName: cardholder.individual?.first_name ?? undefined,
  individualLastName: cardholder.individual?.last_name ?? undefined,
  requirementsDisabledReason:
    cardholder.requirements.disabled_reason ?? undefined,
  requirementsPastDue: [...(cardholder.requirements.past_due ?? [])],
  metadata: stripInternalMetadata(toMetadata(cardholder.metadata)),
  livemode: cardholder.livemode,
  createdAt: cardholder.created,
});

/**
 * Narrow Stripe's `{ [k: string]: string | undefined }` metadata map onto the
 * `Record<string, string>` the branding helpers work with.
 */
const toMetadata = (
  map: { readonly [key: string]: string | undefined } | null | undefined,
): Metadata =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/** Convert a camelCase props address into Stripe's wire shape. */
export const toRequestAddress = (address: {
  city: string | undefined;
  country: string | undefined;
  line1: string | undefined;
  line2?: string | undefined;
  postalCode: string | undefined;
  state?: string | undefined;
}) => ({
  city: address.city ?? "",
  country: address.country ?? "",
  line1: address.line1 ?? "",
  postal_code: address.postalCode ?? "",
  ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
  ...(address.state !== undefined ? { state: address.state } : {}),
});

/** Convert Stripe's echoed (fully nullable) address into camelCase. */
export const toObservedAddress = (address: {
  readonly city: string | null;
  readonly country: string | null;
  readonly line1: string | null;
  readonly line2: string | null;
  readonly postal_code: string | null;
  readonly state: string | null;
}): IssuingObservedAddress => ({
  city: address.city ?? undefined,
  country: address.country ?? undefined,
  line1: address.line1 ?? undefined,
  line2: address.line2 ?? undefined,
  postalCode: address.postal_code ?? undefined,
  state: address.state ?? undefined,
});

const toRequestCompany = (company: IssuingCardholderCompany) => ({
  ...(company.taxId !== undefined ? { tax_id: company.taxId } : {}),
});

const toRequestIndividual = (individual: IssuingCardholderIndividual) => ({
  ...(individual.firstName !== undefined
    ? { first_name: individual.firstName }
    : {}),
  ...(individual.lastName !== undefined
    ? { last_name: individual.lastName }
    : {}),
  ...(individual.dob !== undefined ? { dob: individual.dob } : {}),
  ...(individual.verification !== undefined
    ? {
        verification: {
          document: {
            ...(individual.verification.front !== undefined
              ? { front: individual.verification.front }
              : {}),
            ...(individual.verification.back !== undefined
              ? { back: individual.verification.back }
              : {}),
          },
        },
      }
    : {}),
  ...(individual.termsAcceptance !== undefined
    ? {
        card_issuing: {
          user_terms_acceptance: {
            ...(individual.termsAcceptance.date !== undefined
              ? { date: individual.termsAcceptance.date }
              : {}),
            ...(individual.termsAcceptance.ip !== undefined
              ? { ip: individual.termsAcceptance.ip }
              : {}),
            ...(individual.termsAcceptance.userAgent !== undefined
              ? { user_agent: individual.termsAcceptance.userAgent }
              : {}),
          },
        },
      }
    : {}),
});

const toDob = (
  dob:
    | {
        readonly day: number | null;
        readonly month: number | null;
        readonly year: number | null;
      }
    | null
    | undefined,
): IssuingCardholderDob | undefined => {
  if (dob == null) return undefined;
  if (dob.day == null || dob.month == null || dob.year == null)
    return undefined;
  return { day: dob.day, month: dob.month, year: dob.year };
};

/**
 * Convert camelCase spending controls into Stripe's wire shape. Shared by
 * {@link IssuingCardholder} and `IssuingCard` — the card create/update
 * endpoints reject `spending_limits_currency`, so callers that target a card
 * must pass controls without it.
 */
export const toRequestSpendingControls = (
  controls: IssuingSpendingControls,
) => ({
  ...(controls.allowedCardPresences !== undefined
    ? { allowed_card_presences: controls.allowedCardPresences }
    : {}),
  ...(controls.allowedCategories !== undefined
    ? { allowed_categories: controls.allowedCategories }
    : {}),
  ...(controls.allowedMerchantCountries !== undefined
    ? { allowed_merchant_countries: controls.allowedMerchantCountries }
    : {}),
  ...(controls.blockedCardPresences !== undefined
    ? { blocked_card_presences: controls.blockedCardPresences }
    : {}),
  ...(controls.blockedCategories !== undefined
    ? { blocked_categories: controls.blockedCategories }
    : {}),
  ...(controls.blockedMerchantCountries !== undefined
    ? { blocked_merchant_countries: controls.blockedMerchantCountries }
    : {}),
  ...(controls.spendingLimits !== undefined
    ? {
        spending_limits: controls.spendingLimits.map((limit) => ({
          amount: limit.amount,
          interval: limit.interval,
          ...(limit.categories !== undefined
            ? { categories: limit.categories }
            : {}),
        })),
      }
    : {}),
  ...(controls.spendingLimitsCurrency !== undefined
    ? { spending_limits_currency: controls.spendingLimitsCurrency }
    : {}),
});

/** Observed spending controls (all-nullable) in camelCase, for Attributes. */
export const toSpendingControls = (
  controls:
    | {
        readonly allowed_card_presences: readonly string[] | null;
        readonly allowed_categories: readonly string[] | null;
        readonly allowed_merchant_countries: readonly string[] | null;
        readonly blocked_card_presences: readonly string[] | null;
        readonly blocked_categories: readonly string[] | null;
        readonly blocked_merchant_countries: readonly string[] | null;
        readonly spending_limits:
          | readonly {
              readonly amount: number;
              readonly interval: string;
              readonly categories: readonly string[] | null;
            }[]
          | null;
        readonly spending_limits_currency?: string | null;
      }
    | null
    | undefined,
): IssuingSpendingControls | undefined => {
  if (controls == null) return undefined;
  return {
    ...(controls.allowed_card_presences !== null
      ? { allowedCardPresences: [...controls.allowed_card_presences] }
      : {}),
    ...(controls.allowed_categories !== null
      ? { allowedCategories: [...controls.allowed_categories] }
      : {}),
    ...(controls.allowed_merchant_countries !== null
      ? { allowedMerchantCountries: [...controls.allowed_merchant_countries] }
      : {}),
    ...(controls.blocked_card_presences !== null
      ? { blockedCardPresences: [...controls.blocked_card_presences] }
      : {}),
    ...(controls.blocked_categories !== null
      ? { blockedCategories: [...controls.blocked_categories] }
      : {}),
    ...(controls.blocked_merchant_countries !== null
      ? { blockedMerchantCountries: [...controls.blocked_merchant_countries] }
      : {}),
    ...(controls.spending_limits !== null
      ? {
          spendingLimits: controls.spending_limits.map((limit) => ({
            amount: limit.amount,
            interval: limit.interval,
            ...(limit.categories !== null
              ? { categories: [...limit.categories] }
              : {}),
          })),
        }
      : {}),
    ...(controls.spending_limits_currency != null
      ? { spendingLimitsCurrency: controls.spending_limits_currency }
      : {}),
  };
};

/**
 * Project observed spending controls back into the *request* shape so the
 * desired payload can be compared against them field-for-field.
 */
const toObservedSpendingControlsRequest = (
  controls: StripeCardholder["spending_controls"],
) => {
  const observed = toSpendingControls(controls);
  return observed === undefined
    ? undefined
    : toRequestSpendingControls(observed);
};

/**
 * Order-insensitive structural comparison. Arrays of set-like values (merchant
 * categories, countries, card presences) come back from Stripe in an arbitrary
 * order, and object key order is never meaningful, so both are canonicalised
 * before comparing. `undefined` and `null` collapse to the same token — an
 * unset control and a null control mean the same thing to Stripe.
 */
export const deepEqual = (a: unknown, b: unknown): boolean =>
  canonicalize(a) === canonicalize(b);

const canonicalize = (value: unknown): string => {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined && entry !== null)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .sort();
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};
