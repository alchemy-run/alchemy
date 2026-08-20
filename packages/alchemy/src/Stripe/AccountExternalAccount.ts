import type { ExternalAccount } from "@distilled.cloud/stripe/stripe";
import {
  DeleteAccountsAccountExternalAccountsId,
  GetAccounts,
  GetAccountsAccountExternalAccounts,
  GetAccountsAccountExternalAccountsId,
  PostAccountsAccountExternalAccounts,
  PostAccountsAccountExternalAccountsId,
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

/** The kind of payout destination attached to a connected account. */
export type ExternalAccountObject = "bank_account" | "card";

/** Who owns the bank account behind an external account. */
export type AccountHolderType = "individual" | "company";

export type AccountExternalAccountProps = {
  /**
   * ID of the connected account (`acct_…`) the payout destination is
   * attached to.
   *
   * Changing this replaces the external account — Stripe has no API for
   * moving a payout destination between accounts.
   */
  accountId: string;
  /**
   * A **payment-method token** identifying the bank account or debit card to
   * attach — `btok_…` from `Stripe.js`'s `createToken({ bank_account })`, or
   * `tok_…` from a card element.
   *
   * Alchemy deliberately does **not** model Stripe's inline raw-details form
   * of this parameter (`account_number` / `routing_number` / card PAN).
   * Raw account numbers must be tokenized on the client with Stripe.js so
   * they never enter your infrastructure source, your Alchemy state file, or
   * this process's memory. Alchemy only ever handles the resulting token.
   *
   * Tokens are single-use: Stripe consumes the token when the external
   * account is created. Changing this value replaces the external account
   * (a new one is created from the new token, then the old one is deleted).
   */
  externalAccount: string;
  /**
   * Make this the default payout destination for its currency.
   *
   * Mutable in one direction only: Stripe lets you promote an external
   * account to default, but there is no API to demote one. Setting this back
   * to `false` is therefore a no-op — promote a different external account
   * for the same currency instead.
   *
   * @default false
   */
  defaultForCurrency?: boolean;
  /**
   * Name of the person or business that owns the bank account.
   *
   * Mutable. Bank accounts only — ignored for card external accounts, whose
   * cardholder name is fixed by the token.
   */
  accountHolderName?: string;
  /**
   * Whether the bank account is held by an `individual` or a `company`.
   *
   * Mutable. Bank accounts only — ignored for card external accounts.
   */
  accountHolderType?: AccountHolderType;
  /**
   * Arbitrary key/value pairs attached to the external account. Alchemy
   * additionally writes its own `alchemy_stack` / `alchemy_stage` /
   * `alchemy_id` keys to brand ownership; those are stripped from the
   * returned `metadata` attribute.
   *
   * Mutable — keys the user removes are explicitly unset on Stripe.
   */
  metadata?: Record<string, string>;
};

export type AccountExternalAccount = Resource<
  "Stripe.AccountExternalAccount",
  AccountExternalAccountProps,
  {
    /** The external account's Stripe ID (`ba_…` or `card_…`). */
    externalAccountId: string;
    /** ID of the connected account this payout destination belongs to. */
    accountId: string;
    /** Whether Stripe stored the token as a bank account or a card. */
    object: ExternalAccountObject;
    /**
     * Last four digits of the bank account or card number. This is the only
     * fragment of the underlying number Alchemy ever surfaces — the full
     * number is never read back from Stripe or persisted in state.
     */
    last4: string;
    /** Name of the bank behind the account, for bank accounts. */
    bankName: string | undefined;
    /** Card network (`visa`, `mastercard`, …), for card external accounts. */
    brand: string | undefined;
    /** Two-letter ISO country the account or card is located in. */
    country: string | undefined;
    /** Three-letter ISO currency this destination is paid out in. */
    currency: string | undefined;
    /**
     * Stripe's verification/payout status. For external bank accounts one of
     * `new`, `errored`, `verification_failed`,
     * `tokenized_account_number_deactivated`; for cards `new` or `errored`.
     */
    status: string | undefined;
    /** Whether this is the default payout destination for its currency. */
    defaultForCurrency: boolean;
    /** Name of the person or business that owns the bank account. */
    accountHolderName: string | undefined;
    /** Whether the bank account is held by an individual or a company. */
    accountHolderType: string | undefined;
    /** User metadata, with Alchemy's internal `alchemy_*` keys stripped. */
    metadata: Metadata;
  },
  never,
  Providers
>;

type AccountExternalAccountAttributes = AccountExternalAccount["Attributes"];

/**
 * A payout destination — a bank account or a debit card — attached to a
 * Stripe Connect account.
 *
 * Alchemy accepts the payout destination **only as a token**. Stripe's
 * create endpoint also takes raw bank details inline (`account_number`,
 * `routing_number`) but that path is deliberately not modelled: raw numbers
 * would end up in your infrastructure source and in Alchemy's state file.
 * Tokenize on the client with
 * [Stripe.js](https://docs.stripe.com/js/tokens/create_token?type=bankAccount)
 * and hand Alchemy the resulting `btok_…` / `tok_…`. Only Stripe's own safe
 * projections of the destination (`last4`, `bankName`, `country`,
 * `currency`, `status`) are exposed as attributes.
 *
 * Tokens are single-use, so `externalAccount` is immutable: changing it
 * replaces the resource. `accountId` is immutable too — Stripe cannot move a
 * payout destination between connected accounts.
 *
 * Attaching external accounts requires Stripe Connect, and updating one
 * requires a connected account whose
 * `controller.requirement_collection` is `application` (a Custom account).
 *
 * ### Attaching a payout bank account
 * **Example:** Attach a tokenized bank account to a connected account
 * ```typescript
 * const payout = yield* Stripe.AccountExternalAccount("PayoutBank", {
 *   accountId: "acct_1234567890",
 *   externalAccount: process.env.STRIPE_BANK_TOKEN!,
 * });
 * ```
 *
 * **Example:** Fully configured — default destination, named holder, metadata
 * ```typescript
 * const payout = yield* Stripe.AccountExternalAccount("PayoutBank", {
 *   accountId: "acct_1234567890",
 *   externalAccount: process.env.STRIPE_BANK_TOKEN!,
 *   defaultForCurrency: true,
 *   accountHolderName: "Acme Widgets, Inc.",
 *   accountHolderType: "company",
 *   metadata: { team: "finance" },
 * });
 * ```
 *
 * ### Attaching a debit card
 * **Example:** Card payout destination from a card token
 * ```typescript
 * const card = yield* Stripe.AccountExternalAccount("PayoutCard", {
 *   accountId: "acct_1234567890",
 *   externalAccount: process.env.STRIPE_CARD_TOKEN!,
 * });
 * ```
 *
 * `accountHolderName` and `accountHolderType` apply to bank accounts only
 * and are ignored when the token resolves to a card.
 *
 * ### Composing with other Stripe resources
 * **Example:** Route a platform's payouts and record the destination
 * ```typescript
 * const payout = yield* Stripe.AccountExternalAccount("PayoutBank", {
 *   accountId: connectedAccountId,
 *   externalAccount: process.env.STRIPE_BANK_TOKEN!,
 *   defaultForCurrency: true,
 * });
 *
 * const alert = yield* Stripe.Alert("PayoutAlert", {
 *   title: `Payouts to ${payout.bankName ?? payout.brand} ••${payout.last4}`,
 * });
 * ```
 *
 * ### Rotating the destination
 * **Example:** A new token replaces the attached account
 * ```typescript
 * // Deploying with a different token creates the new external account
 * // first, then deletes the old one — `externalAccountId` changes.
 * const payout = yield* Stripe.AccountExternalAccount("PayoutBank", {
 *   accountId: "acct_1234567890",
 *   externalAccount: process.env.STRIPE_BANK_TOKEN_V2!,
 *   defaultForCurrency: true,
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/external_account_bank_accounts
 *
 * @resource
 */
export const AccountExternalAccount = Resource<AccountExternalAccount>(
  "Stripe.AccountExternalAccount",
);

export const AccountExternalAccountProvider = () =>
  Provider.succeed(AccountExternalAccount, {
    stables: [
      "externalAccountId",
      "accountId",
      "object",
      "last4",
      "bankName",
      "brand",
      "country",
      "currency",
    ],
    list: Effect.fn(function* () {
      // External accounts are keyed entirely by their parent connected
      // account, so enumeration means walking every connected account this
      // platform owns and listing each one's payout destinations. On a
      // non-Connect account `GET /v1/accounts` simply returns nothing.
      const accountIds = yield* listAllConnectedAccountIds;
      const rows = yield* Effect.forEach(
        accountIds,
        (accountId) =>
          listAllExternalAccounts(accountId).pipe(
            Effect.map((accounts) =>
              accounts.map((account) =>
                externalAccountAttributes(accountId, account),
              ),
            ),
            // The connected account can be deleted between the two calls.
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as AccountExternalAccountAttributes[]),
            ),
            Effect.catchTag("InvalidRequestError", (e) =>
              e.code === "resource_missing"
                ? Effect.succeed([] as AccountExternalAccountAttributes[])
                : Effect.fail(e),
            ),
          ),
        { concurrency: 5 },
      );
      return rows.flat();
    }),
    diff: Effect.fn(function* ({ olds, news, output }) {
      // `news` arrives as `Input<Props>` during plan — most stacks reference
      // a connected account's id as an Output, so bail out until resolved.
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // Both immutable fields, exhaustively:
      //  - `accountId`: Stripe cannot move a payout destination between
      //    connected accounts.
      //  - `externalAccount`: the token is consumed on create and never
      //    echoed back, so `olds` is the only baseline available. Skip the
      //    comparison on adoption (`olds === undefined`), where re-creating
      //    from a stale token would be strictly worse than leaving it be.
      const accountChanged = news.accountId !== output.accountId;
      const tokenChanged =
        olds !== undefined && news.externalAccount !== olds.externalAccount;
      return accountChanged || tokenChanged
        ? ({ action: "replace" } as const)
        : undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const accountId = output?.accountId ?? olds?.accountId;
      // Without the parent account there is nothing to look in.
      if (accountId === undefined) return undefined;

      if (output?.externalAccountId !== undefined) {
        const observed = yield* getExternalAccount(
          accountId,
          output.externalAccountId,
        );
        return observed === undefined
          ? undefined
          : externalAccountAttributes(accountId, observed);
      }

      // State loss: external account ids are always Stripe-generated, so the
      // only handle left is the `alchemy_*` branding in the metadata map.
      const found = yield* findOwnedExternalAccount(id, accountId);
      return found === undefined
        ? undefined
        : externalAccountAttributes(accountId, found);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const accountId = news.accountId;
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — prefer the cached id, then fall back to a branding scan
      //    so a create whose state commit failed is picked up rather than
      //    retried with an already-consumed token.
      const observed =
        output?.externalAccountId !== undefined
          ? yield* getExternalAccount(accountId, output.externalAccountId)
          : yield* findOwnedExternalAccount(id, accountId);

      // 2. Ensure — create from the token when absent. A token consumed by a
      //    create we never recorded surfaces as `token_already_used`; rescan
      //    for our branding rather than failing the deploy.
      const existing =
        observed ??
        (yield* PostAccountsAccountExternalAccounts({
          account: accountId,
          external_account: news.externalAccount,
          default_for_currency: news.defaultForCurrency,
          metadata: desiredMetadata,
        }).pipe(
          Effect.catchTag("InvalidRequestError", (e) =>
            e.code === "token_already_used"
              ? findOwnedExternalAccount(id, accountId).pipe(
                  Effect.flatMap((found) =>
                    found === undefined
                      ? Effect.fail(e)
                      : Effect.succeed(found),
                  ),
                )
              : Effect.fail(e),
          ),
        ));

      // 3. Sync — diff each mutable aspect against OBSERVED state and issue
      //    at most one update call.
      const isBankAccount = existing.object === "bank_account";
      const observedMetadata = toMetadata(existing.metadata);
      const metadataChanged = !metadataEqual(observedMetadata, desiredMetadata);
      // Stripe only promotes to default; there is no demote API, so a
      // `false` desired value against a `true` observed value is skipped.
      const promoteToDefault =
        (news.defaultForCurrency ?? false) &&
        (existing.default_for_currency ?? false) === false;
      const observedHolderName = isBankAccount
        ? (existing.account_holder_name ?? "")
        : "";
      const observedHolderType = isBankAccount
        ? (existing.account_holder_type ?? "")
        : "";
      const desiredHolderName = news.accountHolderName ?? "";
      const desiredHolderType = news.accountHolderType ?? "";
      // Holder fields exist on bank accounts only — sending them for a card
      // external account is rejected by Stripe.
      const holderNameChanged =
        isBankAccount && desiredHolderName !== observedHolderName;
      const holderTypeChanged =
        isBankAccount && desiredHolderType !== observedHolderType;

      const account =
        metadataChanged ||
        promoteToDefault ||
        holderNameChanged ||
        holderTypeChanged
          ? yield* PostAccountsAccountExternalAccountsId({
              account: accountId,
              id: existing.id,
              metadata: metadataChanged
                ? metadataUpdate(observedMetadata, desiredMetadata)
                : undefined,
              default_for_currency: promoteToDefault ? true : undefined,
              // Stripe unsets a string field when posted as the empty string.
              account_holder_name: holderNameChanged
                ? desiredHolderName
                : undefined,
              account_holder_type: holderTypeChanged
                ? desiredHolderType
                : undefined,
            })
          : existing;

      return externalAccountAttributes(accountId, account);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Idempotent: an external account already detached — or whose parent
      // connected account is gone — is success, not an error.
      yield* DeleteAccountsAccountExternalAccountsId({
        account: output.accountId,
        id: output.externalAccountId,
      }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (e) =>
          e.code === "resource_missing" ? Effect.void : Effect.fail(e),
        ),
      );
    }),
  });

/**
 * `GET /v1/accounts/{account}/external_accounts/{id}`, mapping a missing
 * external account (or a missing parent account) to `undefined`.
 *
 * Stripe answers a deleted object with `invalid_request_error` /
 * `resource_missing` at HTTP 404, and distilled dispatches on `error.type`
 * before status — so the miss can arrive as either tag.
 */
const getExternalAccount = (accountId: string, externalAccountId: string) =>
  GetAccountsAccountExternalAccountsId({
    account: accountId,
    id: externalAccountId,
  }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );

/** The first external account on `accountId` branded for this logical id. */
const findOwnedExternalAccount = Effect.fn(function* (
  id: string,
  accountId: string,
) {
  const accounts = yield* listAllExternalAccounts(accountId).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([] as ExternalAccount[])),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed([] as ExternalAccount[])
        : Effect.fail(e),
    ),
  );
  for (const account of accounts) {
    if (yield* isOwned(id, toMetadata(account.metadata))) return account;
  }
  return undefined;
});

/**
 * Exhaustively enumerate one connected account's external accounts via
 * Stripe's `starting_after` cursor. Bounded at 20 pages (2k destinations) so
 * a misbehaving cursor can never spin forever.
 */
const listAllExternalAccounts = (accountId: string) =>
  Effect.gen(function* () {
    const accounts: ExternalAccount[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = yield* GetAccountsAccountExternalAccounts({
        account: accountId,
        limit: 100,
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      accounts.push(...res.data);
      const last = res.data[res.data.length - 1];
      if (!res.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return accounts;
  });

/**
 * Exhaustively enumerate the platform's connected account ids. Bounded at
 * 100 pages (10k accounts). A platform without Connect enabled simply has
 * none.
 */
const listAllConnectedAccountIds = Effect.gen(function* () {
  const ids: string[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = yield* GetAccounts({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    ids.push(...res.data.map((account) => account.id));
    const last = res.data[res.data.length - 1];
    if (!res.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return ids;
});

/**
 * Project a Stripe external account onto Alchemy's Attributes.
 *
 * Only Stripe's safe projections of the underlying instrument are carried
 * across — never `routing_number`, an account number, or card expiry.
 */
const externalAccountAttributes = (
  accountId: string,
  account: ExternalAccount,
): AccountExternalAccountAttributes => ({
  externalAccountId: account.id,
  accountId,
  object: account.object,
  last4: account.last4,
  bankName:
    account.object === "bank_account"
      ? (account.bank_name ?? undefined)
      : undefined,
  brand: account.object === "card" ? account.brand : undefined,
  country: account.country ?? undefined,
  currency: account.currency ?? undefined,
  status: account.status ?? undefined,
  defaultForCurrency: account.default_for_currency ?? false,
  accountHolderName:
    account.object === "bank_account"
      ? (account.account_holder_name ?? undefined)
      : undefined,
  accountHolderType:
    account.object === "bank_account"
      ? (account.account_holder_type ?? undefined)
      : undefined,
  metadata: stripInternalMetadata(toMetadata(account.metadata)),
});

/**
 * Stripe's generated metadata maps are typed `{ [k: string]: string |
 * undefined }`; Alchemy's helpers take a dense `Record<string, string>`.
 */
const toMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Metadata => {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};
