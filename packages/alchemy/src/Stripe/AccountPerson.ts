import type { StripeOpError } from "@distilled.cloud/stripe";
import {
  DeleteAccountsAccountPersonsPerson,
  GetAccounts,
  GetAccountsAccountPersons,
  GetAccountsAccountPersonsPerson,
  PostAccountsAccountPersons,
  PostAccountsAccountPersonsPerson,
  type Person as StripePerson,
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

const TypeId = "Stripe.AccountPerson" as const;
type TypeId = typeof TypeId;

/**
 * Upper bound on list pages walked while enumerating persons (or connected
 * accounts). Stripe returns at most 100 objects per page, so this caps a cold
 * read at 10k objects rather than looping unbounded.
 */
const MAX_PAGES = 100;

/** A person's date of birth. */
export type AccountPersonDob = {
  /** Day of birth, 1–31. */
  day: number;
  /** Month of birth, 1–12. */
  month: number;
  /** Four-digit year of birth. */
  year: number;
};

/** A person's postal address. */
export type AccountPersonAddress = {
  /** Street address, PO box, or company name. */
  line1?: string;
  /** Apartment, suite, unit, or building. */
  line2?: string;
  /** City, district, suburb, town, or village. */
  city?: string;
  /** State, county, province, or region. */
  state?: string;
  /** ZIP or postal code. */
  postalCode?: string;
  /** Two-letter ISO country code, e.g. `US`. */
  country?: string;
};

/** The roles a person holds with respect to the connected account. */
export type AccountPersonRelationship = {
  /** Whether the person is a director of the account's legal entity. */
  director?: boolean;
  /** Whether the person is an executive of the account's legal entity. */
  executive?: boolean;
  /** Whether the person owns part of the account's legal entity. */
  owner?: boolean;
  /**
   * Whether the person is authorized as the primary representative of the
   * account. Exactly one person per account may be the representative.
   */
  representative?: boolean;
  /** The person's title, e.g. `CEO`. */
  title?: string;
  /**
   * Percentage of the company the person owns, 0–100. Only meaningful when
   * `owner` is `true`.
   */
  percentOwnership?: number;
};

export type AccountPersonProps = {
  /**
   * Stripe id of the connected account this person belongs to, e.g.
   * `acct_1A2b3C4d5E6f`. Usually `account.accountId` of a
   * {@link "./Account.ts".Account}.
   *
   * Immutable: a person cannot be moved between accounts, so changing this
   * replaces the resource.
   */
  accountId: string;
  /** The person's given name. Mutable. */
  firstName?: string;
  /** The person's family name. Mutable. */
  lastName?: string;
  /** The person's email address. Mutable. */
  email?: string;
  /** The person's phone number, in E.164 format. Mutable. */
  phone?: string;
  /** The person's date of birth. Mutable. */
  dob?: AccountPersonDob;
  /** The person's postal address. Mutable. */
  address?: AccountPersonAddress;
  /**
   * The roles the person holds with respect to the account — director,
   * executive, owner, representative, title and percent ownership. Mutable.
   */
  relationship?: AccountPersonRelationship;
  /**
   * Arbitrary key/value pairs stored on the person. Alchemy adds its own
   * `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys alongside these to
   * brand the person as engine-owned; those keys are stripped back out of the
   * `metadata` attribute.
   *
   * Do not put identity documents or government ID numbers here — metadata is
   * not a secure store and is echoed back on every read.
   */
  metadata?: Metadata;
};

export type AccountPersonAttributes = {
  /** Stripe's identifier for the person, e.g. `person_1A2b3C4d5E6f`. */
  personId: string;
  /** Stripe id of the connected account the person belongs to. */
  accountId: string;
  /** The person's given name, as Stripe currently holds it. */
  firstName: string | undefined;
  /** The person's family name, as Stripe currently holds it. */
  lastName: string | undefined;
  /** The person's email address, as Stripe currently holds it. */
  email: string | undefined;
  /** The roles the person currently holds on the account. */
  relationship: AccountPersonRelationship | undefined;
  /**
   * Whether a government ID number has been provided for the person. The
   * number itself is never exposed.
   */
  idNumberProvided: boolean;
  /**
   * Whether the last four digits of the person's US Social Security number
   * have been provided. The digits themselves are never exposed.
   */
  ssnLast4Provided: boolean;
  /**
   * Fields Stripe still needs about this person before the account's
   * capabilities stay enabled. Empty when the person is fully verified.
   */
  requirementsCurrentlyDue: string[];
  /** Unix timestamp (seconds) at which the person was created. */
  created: number;
  /** User-supplied metadata, with alchemy's internal keys removed. */
  metadata: Metadata;
};

export type AccountPerson = Resource<
  TypeId,
  AccountPersonProps,
  AccountPersonAttributes,
  never,
  Providers
>;

/**
 * A person associated with a Stripe Connect connected account's legal
 * entity — a director, executive, owner, or the account's representative.
 *
 * Stripe requires the people behind a connected account to be identified
 * before it will activate the account's capabilities, and it verifies each
 * one. Creating the person is therefore only half of the story: Stripe
 * reports what it still needs in `requirementsCurrentlyDue`, and the account
 * stays restricted until those fields are satisfied.
 *
 * :::caution
 * These props carry real identity data. Date of birth, address and phone
 * number are accepted so a person can be prefilled, but they are deliberately
 * **not** exposed as attributes, so they never land in your state store —
 * only `idNumberProvided` / `ssnLast4Provided` booleans are. Government ID
 * numbers (`id_number`, `ssn_last_4`) are not modelled at all: collect them
 * through Connect Onboarding or a person token rather than committing them to
 * an infrastructure program. If they are ever added here, they must be typed
 * `Redacted.Redacted<string>`.
 * :::
 *
 * ### Adding a Person
 * **Example:** The account's representative
 * ```typescript
 * const representative = yield* Stripe.AccountPerson("Representative", {
 *   accountId: account.accountId,
 *   firstName: "Ada",
 *   lastName: "Lovelace",
 *   relationship: { representative: true, title: "CEO" },
 * });
 * ```
 *
 * **Example:** A fully-specified owner
 * ```typescript
 * const owner = yield* Stripe.AccountPerson("Owner", {
 *   accountId: account.accountId,
 *   firstName: "Ada",
 *   lastName: "Lovelace",
 *   email: "ada@example.com",
 *   phone: "+15555550123",
 *   dob: { day: 1, month: 1, year: 1980 },
 *   address: {
 *     line1: "1 Example Street",
 *     city: "San Francisco",
 *     state: "CA",
 *     postalCode: "94103",
 *     country: "US",
 *   },
 *   relationship: {
 *     owner: true,
 *     director: true,
 *     title: "Founder",
 *     percentOwnership: 80,
 *   },
 *   metadata: { source: "onboarding" },
 * });
 * ```
 *
 * ### Composing with a connected account
 * **Example:** Create the account and its representative together
 * ```typescript
 * const account = yield* Stripe.Account("Merchant", {
 *   type: "custom",
 *   country: "US",
 *   businessType: "company",
 *   capabilities: {
 *     card_payments: { requested: true },
 *     transfers: { requested: true },
 *   },
 * });
 *
 * const representative = yield* Stripe.AccountPerson("Representative", {
 *   accountId: account.accountId,
 *   firstName: "Ada",
 *   lastName: "Lovelace",
 *   relationship: { representative: true, executive: true, title: "CEO" },
 * });
 * ```
 *
 * ### Moving a person between accounts
 * **Example:** A different `accountId` replaces the person
 * ```typescript
 * // Stripe cannot move a person between legal entities, so this creates the
 * // person on the new account and deletes the old one. `personId` changes.
 * const representative = yield* Stripe.AccountPerson("Representative", {
 *   accountId: otherAccount.accountId,
 *   firstName: "Ada",
 *   lastName: "Lovelace",
 *   relationship: { representative: true },
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/persons
 *
 * @resource
 * @product Stripe
 */
export const AccountPerson = Resource<AccountPerson>(TypeId);

/** Returns true if the given value is a Stripe AccountPerson resource. */
export const isAccountPerson = (value: unknown): value is AccountPerson =>
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

const toRelationship = (
  person: StripePerson,
): AccountPersonRelationship | undefined => {
  const relationship = person.relationship;
  if (!relationship) return undefined;
  return {
    ...(relationship.director !== null
      ? { director: relationship.director }
      : {}),
    ...(relationship.executive !== null
      ? { executive: relationship.executive }
      : {}),
    ...(relationship.owner !== null ? { owner: relationship.owner } : {}),
    ...(relationship.representative !== null
      ? { representative: relationship.representative }
      : {}),
    ...(relationship.title !== null ? { title: relationship.title } : {}),
    ...(relationship.percent_ownership !== null
      ? { percentOwnership: relationship.percent_ownership }
      : {}),
  };
};

const toAttributes = (
  accountId: string,
  person: StripePerson,
): AccountPersonAttributes => ({
  personId: person.id,
  accountId: person.account ?? accountId,
  firstName: person.first_name ?? undefined,
  lastName: person.last_name ?? undefined,
  email: person.email ?? undefined,
  relationship: toRelationship(person),
  idNumberProvided: person.id_number_provided ?? false,
  ssnLast4Provided: person.ssn_last_4_provided ?? false,
  requirementsCurrentlyDue: [...(person.requirements?.currently_due ?? [])],
  created: person.created,
  metadata: stripInternalMetadata(toMetadata(person.metadata)),
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

/** Retrieve one person by Stripe id; `undefined` when it (or its account) is gone. */
const getPersonById = (accountId: string, personId: string) =>
  missingAsUndefined(
    GetAccountsAccountPersonsPerson({ account: accountId, person: personId }),
  );

/**
 * Walk every page of `/v1/accounts/{account}/persons`. Bounded by
 * {@link MAX_PAGES}; Stripe pages with `starting_after` + `has_more`. A
 * missing account yields an empty list rather than an error.
 */
const listPersons = Effect.fn(function* (accountId: string) {
  const persons: StripePerson[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* missingAsUndefined(
      GetAccountsAccountPersons({
        account: accountId,
        limit: 100,
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      }),
    );
    if (response === undefined) break;
    persons.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return persons;
});

/**
 * Cold-path discovery: find the person on `accountId` branded with this
 * stack / stage / logical id. Persons have no natural key, so alchemy's
 * `alchemy_*` metadata branding is the only way to re-attach after a lost
 * state row.
 */
const findPersonByBranding = Effect.fn(function* (
  id: string,
  accountId: string,
) {
  const persons = yield* listPersons(accountId);
  for (const person of persons) {
    if (yield* isOwned(id, toMetadata(person.metadata))) return person;
  }
  return undefined;
});

const toRequestAddress = (address: AccountPersonAddress) => ({
  ...(address.line1 !== undefined ? { line1: address.line1 } : {}),
  ...(address.line2 !== undefined ? { line2: address.line2 } : {}),
  ...(address.city !== undefined ? { city: address.city } : {}),
  ...(address.state !== undefined ? { state: address.state } : {}),
  ...(address.postalCode !== undefined
    ? { postal_code: address.postalCode }
    : {}),
  ...(address.country !== undefined ? { country: address.country } : {}),
});

const toRequestRelationship = (relationship: AccountPersonRelationship) => ({
  ...(relationship.director !== undefined
    ? { director: relationship.director }
    : {}),
  ...(relationship.executive !== undefined
    ? { executive: relationship.executive }
    : {}),
  ...(relationship.owner !== undefined ? { owner: relationship.owner } : {}),
  ...(relationship.representative !== undefined
    ? { representative: relationship.representative }
    : {}),
  ...(relationship.title !== undefined ? { title: relationship.title } : {}),
  ...(relationship.percentOwnership !== undefined
    ? { percent_ownership: relationship.percentOwnership }
    : {}),
});

/** Whether the desired date of birth differs from what Stripe holds. */
const dobDiverges = (
  desired: AccountPersonDob | undefined,
  person: StripePerson,
): boolean => {
  if (desired === undefined) return false;
  const observed = person.dob;
  return (
    observed?.day !== desired.day ||
    observed?.month !== desired.month ||
    observed?.year !== desired.year
  );
};

/** Whether the desired address differs from what Stripe holds. */
const addressDiverges = (
  desired: AccountPersonAddress | undefined,
  person: StripePerson,
): boolean => {
  if (desired === undefined) return false;
  const observed = person.address;
  const differs = <K extends keyof AccountPersonAddress>(
    key: K,
    value: string | null | undefined,
  ) => desired[key] !== undefined && desired[key] !== (value ?? undefined);
  return (
    differs("line1", observed?.line1) ||
    differs("line2", observed?.line2) ||
    differs("city", observed?.city) ||
    differs("state", observed?.state) ||
    differs("postalCode", observed?.postal_code) ||
    differs("country", observed?.country)
  );
};

/** Whether the desired roles differ from what Stripe holds. */
const relationshipDiverges = (
  desired: AccountPersonRelationship | undefined,
  person: StripePerson,
): boolean => {
  if (desired === undefined) return false;
  const observed = person.relationship;
  return (
    (desired.director !== undefined &&
      desired.director !== (observed?.director ?? undefined)) ||
    (desired.executive !== undefined &&
      desired.executive !== (observed?.executive ?? undefined)) ||
    (desired.owner !== undefined &&
      desired.owner !== (observed?.owner ?? undefined)) ||
    (desired.representative !== undefined &&
      desired.representative !== (observed?.representative ?? undefined)) ||
    (desired.title !== undefined &&
      desired.title !== (observed?.title ?? undefined)) ||
    (desired.percentOwnership !== undefined &&
      desired.percentOwnership !== (observed?.percent_ownership ?? undefined))
  );
};

export const AccountPersonProvider = () =>
  Provider.succeed(AccountPerson, {
    // `personId` and `created` are assigned once at creation, and a person
    // can never move between accounts (that is a replacement).
    stables: ["personId", "accountId", "created"],

    list: Effect.fn(function* () {
      // Persons are keyed entirely by their parent account, so enumeration
      // fans out over the platform's connected accounts. A non-Connect
      // account gets an empty list from `/v1/accounts` and this costs one
      // request.
      const accounts: string[] = [];
      let startingAfter: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = yield* GetAccounts({
          limit: 100,
          ...(startingAfter !== undefined
            ? { starting_after: startingAfter }
            : {}),
        });
        accounts.push(...response.data.map((account) => account.id));
        const last = response.data[response.data.length - 1];
        if (!response.has_more || last === undefined) break;
        startingAfter = last.id;
      }

      const pages = yield* Effect.forEach(
        accounts,
        (accountId) =>
          listPersons(accountId).pipe(
            Effect.map((persons) =>
              persons.map((person) => toAttributes(accountId, person)),
            ),
          ),
        { concurrency: 5 },
      );
      return pages.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // A person belongs to exactly one legal entity for life.
      if (output !== undefined && news.accountId !== output.accountId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const accountId = output?.accountId ?? olds?.accountId;
      if (!accountId) return undefined;

      // Owned path — refresh through the cached Stripe id.
      if (output?.personId) {
        const observed = yield* getPersonById(accountId, output.personId);
        if (observed) return toAttributes(accountId, observed);
      }

      // Cold read (state loss) — re-discover by alchemy's metadata branding.
      // A branded match is provably ours, so no adoption gate is needed; an
      // unbranded person belongs to somebody else's integration.
      const match = yield* findPersonByBranding(id, accountId);
      return match ? toAttributes(accountId, match) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const accountId = news.accountId;
      const metadata = yield* brandMetadata(id, news.metadata);

      const payload = {
        ...(news.firstName !== undefined ? { first_name: news.firstName } : {}),
        ...(news.lastName !== undefined ? { last_name: news.lastName } : {}),
        ...(news.email !== undefined ? { email: news.email } : {}),
        ...(news.phone !== undefined ? { phone: news.phone } : {}),
        ...(news.dob !== undefined ? { dob: news.dob } : {}),
        ...(news.address !== undefined
          ? { address: toRequestAddress(news.address) }
          : {}),
        ...(news.relationship !== undefined
          ? { relationship: toRequestRelationship(news.relationship) }
          : {}),
      };

      // 1. Observe — the cached id is a hint, not proof the person still
      //    exists. Fall back to the branding search so a create whose state
      //    commit failed is re-attached instead of duplicated.
      let observed =
        output?.personId && output.accountId === accountId
          ? yield* getPersonById(accountId, output.personId)
          : undefined;
      if (!observed) {
        observed = yield* findPersonByBranding(id, accountId);
      }

      // 2. Ensure — create when missing.
      if (!observed) {
        return toAttributes(
          accountId,
          yield* PostAccountsAccountPersons({
            account: accountId,
            ...payload,
            metadata,
          }),
        );
      }

      // 3. Sync — every field is observable on the live person, so diff
      //    desired against OBSERVED and skip the update entirely on a no-op.
      const observedMetadata = toMetadata(observed.metadata);
      const needsUpdate =
        (news.firstName !== undefined &&
          news.firstName !== (observed.first_name ?? undefined)) ||
        (news.lastName !== undefined &&
          news.lastName !== (observed.last_name ?? undefined)) ||
        (news.email !== undefined &&
          news.email !== (observed.email ?? undefined)) ||
        (news.phone !== undefined &&
          news.phone !== (observed.phone ?? undefined)) ||
        dobDiverges(news.dob, observed) ||
        addressDiverges(news.address, observed) ||
        relationshipDiverges(news.relationship, observed) ||
        !metadataEqual(observedMetadata, metadata);

      if (!needsUpdate) return toAttributes(accountId, observed);

      return toAttributes(
        accountId,
        yield* PostAccountsAccountPersonsPerson({
          account: accountId,
          person: observed.id,
          ...payload,
          metadata: metadataUpdate(observedMetadata, metadata),
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent: an already-deleted person — or a person whose whole
      // account has been deleted — is success, not an error.
      yield* missingAsUndefined(
        DeleteAccountsAccountPersonsPerson({
          account: output.accountId,
          person: output.personId,
        }),
      );
    }),
  });
