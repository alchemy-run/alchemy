import type { StripeOpError } from "@distilled.cloud/stripe";
import {
  type AccountBusinessType,
  type AccountCapabilities,
  type AccountType,
  DeleteAccountsAccount,
  GetAccounts,
  GetAccountsAccount,
  PostAccounts,
  PostAccountsAccount,
  type PostAccountsRequestBusinessProfile,
  type PostAccountsRequestCapabilities,
  type PostAccountsRequestCompany,
  type PostAccountsRequestController,
  type PostAccountsRequestIndividual,
  type PostAccountsRequestSettings,
  type PostAccountsRequestTosAcceptance,
  type Account as StripeAccount,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
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

const TypeId = "Stripe.Account" as const;
type TypeId = typeof TypeId;

/**
 * Upper bound on `/v1/accounts` list pages walked while searching for an
 * account. Stripe returns at most 100 objects per page, so this caps a cold
 * read at 10k connected accounts rather than looping unbounded.
 */
const MAX_PAGES = 100;

/** The Stripe account types that can be created through `/v1/accounts`. */
export type AccountKind = "standard" | "express" | "custom";

export type AccountProps = {
  /**
   * The kind of connected account to create — `standard`, `express` or
   * `custom`. Immutable: changing it replaces the account.
   *
   * Mutually exclusive with {@link AccountProps.controller}; supply one or
   * the other. Omitting both makes Stripe default to a Standard account.
   */
  type?: AccountKind;
  /**
   * Two-letter ISO country code of the account holder's country, e.g. `US`.
   * Immutable: changing it replaces the account. When omitted, Stripe
   * defaults to the platform's own country.
   */
  country?: string;
  /**
   * Email address of the account holder. Only used to make the account
   * easier to identify — Stripe does not market to it. Mutable.
   */
  email?: string;
  /**
   * The account holder's legal structure. Mutable, but for accounts where
   * `controller.requirement_collection` is `stripe` (Standard and Express)
   * it becomes read-only once onboarding has started.
   */
  businessType?: AccountBusinessType;
  /**
   * Public-facing business information (name, url, support contacts, MCC).
   * Mutable.
   *
   * Nested fields use Stripe's wire names (snake_case) because the shape is
   * mirrored straight from the Stripe API request schema.
   */
  businessProfile?: PostAccountsRequestBusinessProfile;
  /**
   * Capabilities to request for the account, keyed by Stripe capability name
   * (`card_payments`, `transfers`, …) with a `{ requested: boolean }` value.
   * Mutable — Alchemy diffs the requested set against the capability statuses
   * Stripe reports and only issues an update when they disagree.
   *
   * Requesting a capability does not activate it: Stripe activates it once
   * the account satisfies the capability's requirements.
   *
   * Nested fields use Stripe's wire names (snake_case) because the shape is
   * mirrored straight from the Stripe API request schema.
   */
  capabilities?: PostAccountsRequestCapabilities;
  /**
   * Account behaviour settings — branding, payouts schedule, card payments,
   * invoices, treasury and so on. Mutable.
   *
   * Nested fields use Stripe's wire names (snake_case) because the shape is
   * mirrored straight from the Stripe API request schema.
   */
  settings?: PostAccountsRequestSettings;
  /**
   * Three-letter ISO currency code used as the account's default currency.
   * Must be a currency Stripe supports in the account's country. Mutable.
   */
  defaultCurrency?: string;
  /**
   * Information about the company or business behind the account. Available
   * for any `businessType`. Mutable while
   * `controller.requirement_collection` is `application` (Custom accounts).
   *
   * Nested fields use Stripe's wire names (snake_case) because the shape is
   * mirrored straight from the Stripe API request schema.
   */
  company?: PostAccountsRequestCompany;
  /**
   * Information about the individual represented by the account. Only
   * meaningful when `businessType` is `individual`. Mutable while
   * `controller.requirement_collection` is `application` (Custom accounts).
   *
   * This carries real identity data (name, date of birth, government ID
   * numbers). Prefer collecting it through Connect Onboarding or an account
   * token rather than committing it to your infrastructure program.
   *
   * Nested fields use Stripe's wire names (snake_case) because the shape is
   * mirrored straight from the Stripe API request schema.
   */
  individual?: PostAccountsRequestIndividual;
  /**
   * Record of the account holder accepting the Stripe Services Agreement —
   * the timestamp, IP address and user agent of the acceptance. Mutable, and
   * only settable for accounts where `controller.requirement_collection` is
   * `application` (Custom accounts).
   *
   * Nested fields use Stripe's wire names (snake_case) because the shape is
   * mirrored straight from the Stripe API request schema.
   */
  tosAcceptance?: PostAccountsRequestTosAcceptance;
  /**
   * Who is responsible for fees, losses, requirement collection and
   * dashboard access on this account. Immutable: changing it replaces the
   * account.
   *
   * Mutually exclusive with {@link AccountProps.type}; supply one or the
   * other.
   *
   * Nested fields use Stripe's wire names (snake_case) because the shape is
   * mirrored straight from the Stripe API request schema.
   */
  controller?: PostAccountsRequestController;
  /**
   * Arbitrary key/value pairs stored on the account. Alchemy adds its own
   * `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys alongside these to
   * brand the account as engine-owned; those keys are stripped back out of
   * the `metadata` attribute.
   */
  metadata?: Metadata;
};

export type AccountAttributes = {
  /** Stripe's identifier for the account, e.g. `acct_1A2b3C4d5E6f`. */
  accountId: string;
  /**
   * The Stripe account type — `standard`, `express`, `custom`, or `none`
   * for accounts created with an explicit `controller` instead.
   */
  accountType: AccountType | undefined;
  /** Two-letter ISO country code the account is registered in. */
  country: string | undefined;
  /** Email address associated with the account. */
  email: string | undefined;
  /** The account holder's legal structure, once known. */
  businessType: AccountBusinessType | undefined;
  /** Three-letter ISO code of the account's default currency. */
  defaultCurrency: string | undefined;
  /** Whether the account can currently process charges. */
  chargesEnabled: boolean;
  /** Whether funds in the account can currently be paid out. */
  payoutsEnabled: boolean;
  /**
   * Whether the account has finished submitting its details. Accounts with
   * Stripe Dashboard access cannot receive payouts until this is `true`.
   */
  detailsSubmitted: boolean;
  /**
   * Capability name → status (`active`, `pending`, `inactive`) for every
   * capability Stripe reports on the account.
   */
  capabilities: Record<string, string>;
  /**
   * Fields Stripe needs before the account's capabilities stay enabled.
   * Empty when the account is fully verified.
   */
  requirementsCurrentlyDue: string[];
  /** Why the account is currently disabled, if it is. */
  requirementsDisabledReason: string | undefined;
  /** Unix timestamp (seconds) at which the account was connected. */
  created: number | undefined;
  /** User-supplied metadata, with alchemy's internal keys removed. */
  metadata: Metadata;
};

export type Account = Resource<
  TypeId,
  AccountProps,
  AccountAttributes,
  never,
  Providers
>;

/**
 * A Stripe Connect connected account — a Standard, Express or Custom account
 * created by your platform on behalf of one of your users.
 *
 * Creating an account is only the first step of onboarding: Stripe activates
 * the requested capabilities once the account satisfies their requirements,
 * so a freshly-created account normally reports `chargesEnabled: false` and a
 * non-empty `requirementsCurrentlyDue`. Driving the account holder through
 * onboarding is a runtime action, not infrastructure — Account Links and
 * Login Links are one-shot, short-lived, single-use URLs, so Alchemy
 * deliberately does not model them as resources. Mint them at runtime with
 * `/v1/account_links` and `/v1/accounts/{account}/login_links` instead.
 *
 * :::caution
 * Stripe only lets you delete accounts your platform created, and only when
 * every balance is zero. Test-mode accounts can be deleted at any time;
 * live-mode Standard accounts can never be deleted through the API. When
 * Stripe refuses, the destroy fails with the refusal rather than silently
 * orphaning the account — zero the balances (or remove the account from the
 * Dashboard) and destroy again.
 * :::
 *
 * ### Creating an Account
 * **Example:** A Standard connected account
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   type: "standard",
 *   country: "US",
 *   email: "merchant@example.com",
 * });
 * ```
 *
 * **Example:** An Express account requesting payment capabilities
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   type: "express",
 *   country: "US",
 *   email: "merchant@example.com",
 *   capabilities: {
 *     card_payments: { requested: true },
 *     transfers: { requested: true },
 *   },
 * });
 * ```
 *
 * ### Fully configuring an Account
 * **Example:** A Custom account with business profile, settings and metadata
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   type: "custom",
 *   country: "US",
 *   email: "merchant@example.com",
 *   businessType: "company",
 *   defaultCurrency: "usd",
 *   businessProfile: {
 *     name: "Example Merchant",
 *     url: "https://example.com",
 *     mcc: "5734",
 *     support_email: "support@example.com",
 *   },
 *   capabilities: {
 *     card_payments: { requested: true },
 *     transfers: { requested: true },
 *   },
 *   settings: {
 *     payouts: { schedule: { interval: "manual" } },
 *     branding: { primary_color: "#0055ff" },
 *   },
 *   metadata: { tier: "gold" },
 * });
 * ```
 *
 * **Example:** Choosing responsibilities with a controller instead of a type
 * ```typescript
 * // `controller` and `type` are mutually exclusive, and both are immutable —
 * // changing either replaces the account.
 * const account = yield* Stripe.Account("Merchant", {
 *   country: "US",
 *   controller: {
 *     losses: { payments: "application" },
 *     fees: { payer: "application" },
 *     requirement_collection: "application",
 *     stripe_dashboard: { type: "none" },
 *   },
 * });
 * ```
 *
 * ### Composing with other Stripe resources
 * **Example:** Adding a representative to the account
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   type: "custom",
 *   country: "US",
 *   businessType: "company",
 * });
 *
 * const representative = yield* Stripe.AccountPerson("Representative", {
 *   accountId: account.accountId,
 *   firstName: "Ada",
 *   lastName: "Lovelace",
 *   relationship: { representative: true, title: "CEO" },
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/accounts
 *
 * @resource
 * @product Stripe
 */
export const Account = Resource<Account>(TypeId);

/** Returns true if the given value is a Stripe Account resource. */
export const isAccount = (value: unknown): value is Account =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

/**
 * Normalize a Stripe metadata map (whose values are typed `string |
 * undefined`) into alchemy's dense `Record<string, string>` shape.
 */
const toMetadata = (
  map: { [key: string]: string | undefined } | null | undefined,
): Metadata =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/** Flatten the capability status object into `name → status`. */
const capabilityStatuses = (
  capabilities: AccountCapabilities | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(capabilities ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

const toAttributes = (account: StripeAccount): AccountAttributes => ({
  accountId: account.id,
  accountType: account.type,
  country: account.country,
  email: account.email ?? undefined,
  businessType: account.business_type ?? undefined,
  defaultCurrency: account.default_currency,
  chargesEnabled: account.charges_enabled ?? false,
  payoutsEnabled: account.payouts_enabled ?? false,
  detailsSubmitted: account.details_submitted ?? false,
  capabilities: capabilityStatuses(account.capabilities),
  requirementsCurrentlyDue: [...(account.requirements?.currently_due ?? [])],
  requirementsDisabledReason:
    account.requirements?.disabled_reason ?? undefined,
  created: account.created,
  metadata: stripInternalMetadata(toMetadata(account.metadata)),
});

/**
 * Stripe answers a lookup for a deleted/never-existing object with HTTP 404
 * and `type: "invalid_request_error"`, `code: "resource_missing"`. Distilled
 * dispatches on `type` before status, so that surfaces as
 * `InvalidRequestError` rather than `NotFound` — both are treated as absent.
 *
 * TODO(distilled): patch the Stripe model so `resource_missing` is typed as a
 * dedicated `NotFound`-shaped tag and this second arm can go away.
 */
const missingAsUndefined = <A, R>(
  effect: Effect.Effect<A, StripeOpError, R>,
): Effect.Effect<A | undefined, StripeOpError, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchIf(
      (e) => e._tag === "InvalidRequestError" && e.code === "resource_missing",
      () => Effect.succeed(undefined),
    ),
  );

/** Retrieve one connected account by Stripe id; `undefined` when it is gone. */
const getAccountById = (accountId: string) =>
  missingAsUndefined(GetAccountsAccount({ account: accountId }));

/**
 * Walk every page of `/v1/accounts`. Bounded by {@link MAX_PAGES}; Stripe
 * pages with `starting_after` + `has_more`. Returns an empty list when the
 * caller is not a Connect platform.
 */
const listAccounts = Effect.fn(function* () {
  const accounts: StripeAccount[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetAccounts({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    accounts.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return accounts;
});

/**
 * Cold-path discovery: find the connected account branded with this stack /
 * stage / logical id. Accounts have no natural key, so alchemy's `alchemy_*`
 * metadata branding is the only way to re-attach after a lost state row.
 */
const findAccountByBranding = Effect.fn(function* (id: string) {
  const accounts = yield* listAccounts();
  for (const account of accounts) {
    if (yield* isOwned(id, toMetadata(account.metadata))) return account;
  }
  return undefined;
});

/**
 * Structural comparison used for the write-only nested blobs (`settings`,
 * `company`, `individual`, …) that Stripe does not echo back in the same
 * shape it accepts. Order-sensitive by construction — both sides originate
 * from the same literal in the user's program, so key order is stable.
 */
const structurallyEqual = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Whether the requested capability set disagrees with the statuses Stripe
 * currently reports. A capability whose status is `active` or `pending` has
 * a live request on file; anything else (including absence) does not.
 */
const capabilitiesDiverge = (
  desired: PostAccountsRequestCapabilities | undefined,
  observed: Record<string, string>,
): boolean => {
  if (desired === undefined) return false;
  return Object.entries(desired).some(([name, value]) => {
    const requested = value?.requested;
    if (requested === undefined) return false;
    const status = observed[name];
    const onFile = status === "active" || status === "pending";
    return requested !== onFile;
  });
};

export const AccountProvider = () =>
  Provider.succeed(Account, {
    // `accountId` and `created` are assigned once at creation; everything
    // else can move as onboarding progresses or the account is updated.
    stables: ["accountId", "created"],

    list: Effect.fn(function* () {
      const accounts = yield* listAccounts();
      return accounts.map(toAttributes);
    }),

    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;

      // `type`, `country` and `controller` are fixed at creation — the update
      // endpoint does not accept any of them.
      if (
        news.type !== undefined &&
        output?.accountType !== undefined &&
        news.type !== output.accountType
      ) {
        return { action: "replace" } as const;
      }
      if (
        news.country !== undefined &&
        output?.country !== undefined &&
        news.country !== output.country
      ) {
        return { action: "replace" } as const;
      }
      // `controller` is write-only: Stripe reports a resolved
      // `AccountUnificationAccountController`, not the request shape, so the
      // previously-deployed props are the only usable baseline.
      if (
        olds !== undefined &&
        !structurallyEqual(news.controller, olds.controller)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output }) {
      // Owned path — refresh through the cached Stripe id.
      if (output?.accountId) {
        const observed = yield* getAccountById(output.accountId);
        if (observed) return toAttributes(observed);
      }

      // Cold read (state loss) — re-discover by alchemy's metadata branding.
      // A branded match is provably ours, so no adoption gate is needed; an
      // unbranded account is somebody else's and is invisible here.
      const match = yield* findAccountByBranding(id);
      return match ? toAttributes(match) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const metadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — the cached id is a hint, not proof the account still
      //    exists. Fall back to the branding search so a create whose state
      //    commit failed is re-attached instead of duplicated.
      let observed = output?.accountId
        ? yield* getAccountById(output.accountId)
        : undefined;
      if (!observed) {
        observed = yield* findAccountByBranding(id);
      }

      // 2. Ensure — create when missing. `type`/`country`/`controller` are
      //    only accepted here; the update endpoint rejects them.
      if (!observed) {
        return toAttributes(
          yield* PostAccounts({
            ...(news.type !== undefined ? { type: news.type } : {}),
            ...(news.country !== undefined ? { country: news.country } : {}),
            ...(news.controller !== undefined
              ? { controller: news.controller }
              : {}),
            ...(news.email !== undefined ? { email: news.email } : {}),
            ...(news.businessType !== undefined
              ? { business_type: news.businessType }
              : {}),
            ...(news.businessProfile !== undefined
              ? { business_profile: news.businessProfile }
              : {}),
            ...(news.capabilities !== undefined
              ? { capabilities: news.capabilities }
              : {}),
            ...(news.settings !== undefined ? { settings: news.settings } : {}),
            ...(news.defaultCurrency !== undefined
              ? { default_currency: news.defaultCurrency }
              : {}),
            ...(news.company !== undefined ? { company: news.company } : {}),
            ...(news.individual !== undefined
              ? { individual: news.individual }
              : {}),
            ...(news.tosAcceptance !== undefined
              ? { tos_acceptance: news.tosAcceptance }
              : {}),
            metadata,
          }),
        );
      }

      // 3. Sync — diff desired against the OBSERVED account and issue at most
      //    one update. Scalars and capabilities are compared against live
      //    state; the write-only nested blobs (`settings`, `company`,
      //    `individual`, `tosAcceptance`) are not echoed back in the shape
      //    Stripe accepts, so they fall back to the previously-deployed props
      //    and are re-pushed once on adoption (`olds === undefined`).
      const observedMetadata = toMetadata(observed.metadata);
      const observedCapabilities = capabilityStatuses(observed.capabilities);

      const scalarChanged =
        (news.email !== undefined &&
          news.email !== (observed.email ?? undefined)) ||
        (news.businessType !== undefined &&
          news.businessType !== (observed.business_type ?? undefined)) ||
        (news.defaultCurrency !== undefined &&
          news.defaultCurrency !== observed.default_currency);

      const blobChanged = (value: unknown, old: unknown) =>
        value !== undefined &&
        (olds === undefined || !structurallyEqual(value, old));

      const nestedChanged =
        blobChanged(news.businessProfile, olds?.businessProfile) ||
        blobChanged(news.settings, olds?.settings) ||
        blobChanged(news.company, olds?.company) ||
        blobChanged(news.individual, olds?.individual) ||
        blobChanged(news.tosAcceptance, olds?.tosAcceptance);

      const needsUpdate =
        scalarChanged ||
        nestedChanged ||
        capabilitiesDiverge(news.capabilities, observedCapabilities) ||
        !metadataEqual(observedMetadata, metadata);

      if (!needsUpdate) return toAttributes(observed);

      return toAttributes(
        yield* PostAccountsAccount({
          account: observed.id,
          ...(news.email !== undefined ? { email: news.email } : {}),
          ...(news.businessType !== undefined
            ? { business_type: news.businessType }
            : {}),
          ...(news.businessProfile !== undefined
            ? { business_profile: news.businessProfile }
            : {}),
          ...(news.capabilities !== undefined
            ? { capabilities: news.capabilities }
            : {}),
          ...(news.settings !== undefined ? { settings: news.settings } : {}),
          ...(news.defaultCurrency !== undefined
            ? { default_currency: news.defaultCurrency }
            : {}),
          ...(news.company !== undefined ? { company: news.company } : {}),
          ...(news.individual !== undefined
            ? { individual: news.individual }
            : {}),
          ...(news.tosAcceptance !== undefined
            ? { tos_acceptance: news.tosAcceptance }
            : {}),
          metadata: metadataUpdate(observedMetadata, metadata),
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent with respect to an account that is already gone. A refusal
      // ("cannot delete an account with a non-zero balance", live-mode
      // Standard accounts) is NOT swallowed — silently succeeding there would
      // orphan a real connected account outside of alchemy's state.
      yield* missingAsUndefined(
        DeleteAccountsAccount({ account: output.accountId }),
      );
    }),
  });
