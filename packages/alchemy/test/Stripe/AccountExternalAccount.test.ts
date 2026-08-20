import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  DeleteAccountsAccount,
  GetAccountsAccountExternalAccounts,
  GetAccountsAccountExternalAccountsId,
  PostAccounts,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Attaching an external account requires a Connect platform, and updating
 * one requires a connected account whose `controller.requirement_collection`
 * is `application` (a Custom account). A plain Stripe test account has
 * neither, so the whole suite is gated.
 */
const SKIP_CONNECT = process.env.STRIPE_TEST_CONNECT !== "1";

/**
 * Stripe's documented test-mode tokens. Never a real bank or card number —
 * raw details are tokenized client-side by Stripe.js in production.
 *
 * @see https://docs.stripe.com/connect/testing
 */
const BANK_TOKEN = "btok_us_verified";
const BANK_TOKEN_ROTATED = "btok_us";
const CARD_TOKEN = "tok_visa_debit";

/** Create a throwaway Custom connected account to hang payouts off of. */
const createConnectedAccount = PostAccounts({
  type: "custom",
  country: "US",
  business_type: "individual",
  capabilities: { transfers: { requested: true } },
});

/** Idempotent teardown for the throwaway connected account. */
const deleteConnectedAccount = (accountId: string) =>
  DeleteAccountsAccount({ account: accountId }).pipe(Effect.ignore);

/** `GET` one external account, mapping "gone" onto `undefined`. */
const fetchExternalAccount = (accountId: string, externalAccountId: string) =>
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

test.provider.skipIf(SKIP_CONNECT)(
  "create, update and delete a bank external account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const account = yield* createConnectedAccount;

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Stripe.AccountExternalAccount("PayoutBank", {
            accountId: account.id,
            externalAccount: BANK_TOKEN,
          }),
        );

        expect(created.externalAccountId).toBeDefined();
        expect(created.accountId).toEqual(account.id);
        expect(created.object).toEqual("bank_account");
        expect(created.last4).toBeDefined();
        expect(created.country).toEqual("US");
        expect(created.currency).toEqual("usd");

        // Out-of-band verification: the destination really is attached.
        const fetched = yield* GetAccountsAccountExternalAccountsId({
          account: account.id,
          id: created.externalAccountId,
        });
        expect(fetched.id).toEqual(created.externalAccountId);

        // In-place update — the id must survive.
        const updated = yield* stack.deploy(
          Stripe.AccountExternalAccount("PayoutBank", {
            accountId: account.id,
            externalAccount: BANK_TOKEN,
            accountHolderName: "Acme Widgets, Inc.",
            accountHolderType: "company",
            metadata: { team: "finance" },
          }),
        );

        expect(updated.externalAccountId).toEqual(created.externalAccountId);
        expect(updated.accountHolderName).toEqual("Acme Widgets, Inc.");
        expect(updated.accountHolderType).toEqual("company");
        expect(updated.metadata).toEqual({ team: "finance" });

        const refetched = yield* GetAccountsAccountExternalAccountsId({
          account: account.id,
          id: created.externalAccountId,
        });
        expect(refetched).toMatchObject({
          account_holder_name: "Acme Widgets, Inc.",
          account_holder_type: "company",
        });
        // Alchemy's branding lives alongside the user's metadata.
        expect(refetched.metadata).toMatchObject({ team: "finance" });
        expect(refetched.metadata?.alchemy_id).toEqual("PayoutBank");

        // Removing a metadata key unsets it on Stripe rather than leaving it.
        const cleared = yield* stack.deploy(
          Stripe.AccountExternalAccount("PayoutBank", {
            accountId: account.id,
            externalAccount: BANK_TOKEN,
            accountHolderName: "Acme Widgets, Inc.",
            accountHolderType: "company",
          }),
        );
        expect(cleared.externalAccountId).toEqual(created.externalAccountId);
        expect(cleared.metadata).toEqual({});

        yield* stack.destroy();

        const afterDelete = yield* fetchExternalAccount(
          account.id,
          created.externalAccountId,
        );
        expect(afterDelete).toBeUndefined();
      }).pipe(Effect.ensuring(deleteConnectedAccount(account.id)));
    }),
);

test.provider.skipIf(SKIP_CONNECT)(
  "create a fully configured bank external account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const account = yield* createConnectedAccount;

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Stripe.AccountExternalAccount("PayoutBankFull", {
            accountId: account.id,
            externalAccount: BANK_TOKEN,
            defaultForCurrency: true,
            accountHolderName: "Jenny Rosen",
            accountHolderType: "individual",
            metadata: { env: "test", owner: "platform" },
          }),
        );

        expect(created.object).toEqual("bank_account");
        expect(created.defaultForCurrency).toEqual(true);
        expect(created.accountHolderName).toEqual("Jenny Rosen");
        expect(created.accountHolderType).toEqual("individual");
        expect(created.bankName).toBeDefined();
        expect(created.brand).toBeUndefined();
        expect(created.metadata).toEqual({ env: "test", owner: "platform" });

        const fetched = yield* GetAccountsAccountExternalAccountsId({
          account: account.id,
          id: created.externalAccountId,
        });
        expect(fetched).toMatchObject({
          object: "bank_account",
          default_for_currency: true,
          account_holder_name: "Jenny Rosen",
          account_holder_type: "individual",
        });

        yield* stack.destroy();

        const afterDelete = yield* fetchExternalAccount(
          account.id,
          created.externalAccountId,
        );
        expect(afterDelete).toBeUndefined();
      }).pipe(Effect.ensuring(deleteConnectedAccount(account.id)));
    }),
);

test.provider.skipIf(SKIP_CONNECT)(
  "rotating the token replaces the external account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const account = yield* createConnectedAccount;

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Stripe.AccountExternalAccount("PayoutBankRotate", {
            accountId: account.id,
            externalAccount: BANK_TOKEN,
            // Both generations claim the default so the replacement's
            // create-then-delete never has to delete a currency default.
            defaultForCurrency: true,
          }),
        );
        expect(created.externalAccountId).toBeDefined();

        const replaced = yield* stack.deploy(
          Stripe.AccountExternalAccount("PayoutBankRotate", {
            accountId: account.id,
            externalAccount: BANK_TOKEN_ROTATED,
            defaultForCurrency: true,
          }),
        );

        // The token is immutable — a new one means a new external account.
        expect(replaced.externalAccountId).not.toEqual(
          created.externalAccountId,
        );
        expect(replaced.accountId).toEqual(account.id);

        const oldAccount = yield* fetchExternalAccount(
          account.id,
          created.externalAccountId,
        );
        expect(oldAccount).toBeUndefined();

        const newAccount = yield* GetAccountsAccountExternalAccountsId({
          account: account.id,
          id: replaced.externalAccountId,
        });
        expect(newAccount.id).toEqual(replaced.externalAccountId);

        yield* stack.destroy();

        const list = yield* GetAccountsAccountExternalAccounts({
          account: account.id,
          limit: 100,
        });
        expect(
          list.data.some((row) => row.id === replaced.externalAccountId),
        ).toEqual(false);
      }).pipe(Effect.ensuring(deleteConnectedAccount(account.id)));
    }),
);

test.provider.skipIf(SKIP_CONNECT)(
  "attach a debit card as a payout destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const account = yield* createConnectedAccount;

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Stripe.AccountExternalAccount("PayoutCard", {
            accountId: account.id,
            externalAccount: CARD_TOKEN,
            metadata: { channel: "card" },
          }),
        );

        expect(created.object).toEqual("card");
        expect(created.brand).toBeDefined();
        expect(created.bankName).toBeUndefined();
        expect(created.last4).toBeDefined();
        expect(created.metadata).toEqual({ channel: "card" });

        const fetched = yield* GetAccountsAccountExternalAccountsId({
          account: account.id,
          id: created.externalAccountId,
        });
        expect(fetched.object).toEqual("card");

        yield* stack.destroy();

        const afterDelete = yield* fetchExternalAccount(
          account.id,
          created.externalAccountId,
        );
        expect(afterDelete).toBeUndefined();
      }).pipe(Effect.ensuring(deleteConnectedAccount(account.id)));
    }),
);
