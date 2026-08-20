import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetAccountsAccount } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Connect must be enabled and onboarded on the Stripe account backing the
 * `testing` profile before `/v1/accounts` will create anything — a plain
 * (non-platform) test account rejects every call here. Set
 * `STRIPE_TEST_CONNECT=1` on an entitled account to run the suite.
 */
const connect = test.provider.skipIf(process.env.STRIPE_TEST_CONNECT !== "1");

connect("create a standard account with minimal props", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const account = yield* stack.deploy(
      Stripe.Account("MinimalAccount", {
        type: "standard",
        country: "US",
      }),
    );

    expect(account.accountId).toBeDefined();
    expect(account.accountId.startsWith("acct_")).toBe(true);
    expect(account.accountType).toEqual("standard");
    expect(account.country).toEqual("US");
    expect(account.metadata).toEqual({});

    // Out-of-band: the account really exists, and carries alchemy's branding.
    const fetched = yield* GetAccountsAccount({ account: account.accountId });
    expect(fetched.id).toEqual(account.accountId);
    expect(fetched.metadata?.alchemy_id).toEqual("MinimalAccount");

    yield* stack.destroy();
  }),
);

connect("create an express account with the full prop surface", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const account = yield* stack.deploy(
      Stripe.Account("FullAccount", {
        type: "express",
        country: "US",
        email: "full-account@example.com",
        businessType: "company",
        defaultCurrency: "usd",
        businessProfile: {
          name: "Alchemy Test Merchant",
          url: "https://example.com",
          mcc: "5734",
          support_email: "support@example.com",
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        settings: {
          payouts: { schedule: { interval: "manual" } },
        },
        metadata: { tier: "gold" },
      }),
    );

    expect(account.accountType).toEqual("express");
    expect(account.email).toEqual("full-account@example.com");
    expect(account.businessType).toEqual("company");
    expect(account.defaultCurrency).toEqual("usd");
    // Alchemy's internal branding is stripped from the user-facing attribute.
    expect(account.metadata).toEqual({ tier: "gold" });
    // Requesting a capability does not activate it — Stripe reports a status
    // once the request is on file.
    expect(Object.keys(account.capabilities)).toContain("transfers");

    const fetched = yield* GetAccountsAccount({ account: account.accountId });
    expect(fetched.business_profile?.name).toEqual("Alchemy Test Merchant");
    expect(fetched.business_profile?.url).toEqual("https://example.com");
    expect(fetched.settings?.payouts?.schedule?.interval).toEqual("manual");
    expect(fetched.metadata?.tier).toEqual("gold");

    yield* stack.destroy();
  }),
);

connect("update mutable props in place, preserving the account id", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Account("UpdatableAccount", {
        type: "express",
        country: "US",
        email: "before@example.com",
        businessProfile: { name: "Before Co", url: "https://before.example" },
        metadata: { phase: "before", dropped: "yes" },
      }),
    );

    expect(created.email).toEqual("before@example.com");
    expect(created.metadata).toEqual({ phase: "before", dropped: "yes" });

    const updated = yield* stack.deploy(
      Stripe.Account("UpdatableAccount", {
        type: "express",
        country: "US",
        email: "after@example.com",
        businessProfile: { name: "After Co", url: "https://after.example" },
        // `dropped` is removed — Stripe unsets it by posting an empty value.
        metadata: { phase: "after" },
      }),
    );

    expect(updated.accountId).toEqual(created.accountId);
    expect(updated.email).toEqual("after@example.com");
    expect(updated.metadata).toEqual({ phase: "after" });

    const fetched = yield* GetAccountsAccount({ account: updated.accountId });
    expect(fetched.email).toEqual("after@example.com");
    expect(fetched.business_profile?.name).toEqual("After Co");
    expect(fetched.metadata?.phase).toEqual("after");
    expect(fetched.metadata?.dropped).toBeUndefined();
    // Branding survives a user-metadata update.
    expect(fetched.metadata?.alchemy_id).toEqual("UpdatableAccount");

    yield* stack.destroy();
  }),
);

connect("re-deploying identical props is a no-op", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Stripe.Account("StableAccount", {
        type: "standard",
        country: "US",
        email: "stable@example.com",
        metadata: { phase: "stable" },
      }),
    );

    const created = yield* deploy;
    const again = yield* deploy;

    expect(again.accountId).toEqual(created.accountId);
    expect(again.email).toEqual(created.email);
    expect(again.metadata).toEqual({ phase: "stable" });

    yield* stack.destroy();
  }),
);

connect("changing the immutable account type replaces the account", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Stripe.Account("ReplacedAccount", {
        type: "standard",
        country: "US",
        email: "replaced@example.com",
      }),
    );
    expect(created.accountType).toEqual("standard");

    const replaced = yield* stack.deploy(
      Stripe.Account("ReplacedAccount", {
        // `type` is fixed at creation — the update endpoint does not accept
        // it, so this must produce a brand new account.
        type: "express",
        country: "US",
        email: "replaced@example.com",
      }),
    );

    expect(replaced.accountType).toEqual("express");
    expect(replaced.accountId).not.toEqual(created.accountId);

    // The superseded account was deleted as part of the replacement.
    const old = yield* Effect.result(
      GetAccountsAccount({ account: created.accountId }),
    );
    expect(Result.isFailure(old)).toBe(true);

    yield* stack.destroy();
  }),
);

connect("destroying the account deletes it from Stripe", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const account = yield* stack.deploy(
      Stripe.Account("DeletedAccount", {
        type: "standard",
        country: "US",
      }),
    );

    const before = yield* GetAccountsAccount({ account: account.accountId });
    expect(before.id).toEqual(account.accountId);

    yield* stack.destroy();

    // Test-mode accounts can be deleted at any time, so the object is gone
    // rather than merely archived.
    const after = yield* Effect.result(
      GetAccountsAccount({ account: account.accountId }),
    );
    expect(Result.isFailure(after)).toBe(true);
  }),
);
