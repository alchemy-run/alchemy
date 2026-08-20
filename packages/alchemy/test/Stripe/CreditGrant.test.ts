import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetBillingCreditGrantsId } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Fixed, deterministic Unix timestamps (seconds) so re-runs are identical.
const JAN_1_2030 = 1_893_456_000;
const JAN_1_2031 = 1_924_992_000;
const JAN_1_2032 = 1_956_528_000;

test.provider("create, read back and void a minimal credit grant", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { grant, customer } = yield* stack.deploy(
      Effect.gen(function* () {
        const customer = yield* Stripe.Customer("MinimalGrantCustomer", {
          email: "minimal-grant@alchemy-test.example",
          name: "Minimal Grant Customer",
        });
        const grant = yield* Stripe.CreditGrant("MinimalGrant", {
          customerId: customer.customerId,
          amount: { monetary: { currency: "usd", value: 1000 } },
          applicabilityConfig: { scope: { priceType: "metered" } },
        });
        return { grant, customer };
      }),
    );

    expect(grant.creditGrantId).toBeDefined();
    expect(grant.customerId).toEqual(customer.customerId);
    expect(grant.amount.monetary).toMatchObject({
      currency: "usd",
      value: 1000,
    });
    expect(grant.applicabilityConfig.scope.priceType).toEqual("metered");
    // Stripe's documented default category.
    expect(grant.category).toEqual("paid");
    expect(grant.expiresAt).toBeUndefined();
    expect(grant.voidedAt).toBeUndefined();
    // Alchemy's internal branding must never leak into the user-facing attr.
    expect(grant.metadata).toEqual({});

    // Out-of-band verification: the object really exists in Stripe and
    // carries alchemy's ownership branding.
    const fetched = yield* GetBillingCreditGrantsId({
      id: grant.creditGrantId,
    });
    expect(fetched.id).toEqual(grant.creditGrantId);
    expect(fetched.priority ?? undefined).toEqual(grant.priority);
    expect(fetched.metadata[Stripe.ALCHEMY_ID_KEY]).toEqual("MinimalGrant");
    expect(fetched.metadata[Stripe.ALCHEMY_STACK_KEY]).toBeDefined();
    expect(fetched.metadata[Stripe.ALCHEMY_STAGE_KEY]).toBeDefined();

    yield* stack.destroy();

    // Stripe cannot delete a credit grant — destroy voids it, so the object
    // survives with `voided_at` set.
    const voided = yield* GetBillingCreditGrantsId({
      id: grant.creditGrantId,
    });
    expect(voided.voided_at).not.toBeNull();
  }).pipe(logLevel),
);

test.provider("create a fully configured credit grant", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { grant } = yield* stack.deploy(
      Effect.gen(function* () {
        const customer = yield* Stripe.Customer("FullGrantCustomer", {
          email: "full-grant@alchemy-test.example",
          name: "Full Grant Customer",
        });
        const grant = yield* Stripe.CreditGrant("FullGrant", {
          customerId: customer.customerId,
          amount: {
            type: "monetary",
            monetary: { currency: "usd", value: 25_000 },
          },
          applicabilityConfig: { scope: { priceType: "metered" } },
          category: "promotional",
          name: "Alchemy full credit grant",
          effectiveAt: JAN_1_2030,
          expiresAt: JAN_1_2031,
          priority: 10,
          metadata: { contract: "ALCHEMY-TEST-FULL" },
        });
        return { grant };
      }),
    );

    expect(grant.category).toEqual("promotional");
    expect(grant.name).toEqual("Alchemy full credit grant");
    expect(grant.effectiveAt).toEqual(JAN_1_2030);
    expect(grant.expiresAt).toEqual(JAN_1_2031);
    expect(grant.priority).toEqual(10);
    expect(grant.metadata).toEqual({ contract: "ALCHEMY-TEST-FULL" });

    const fetched = yield* GetBillingCreditGrantsId({
      id: grant.creditGrantId,
    });
    expect(fetched.category).toEqual("promotional");
    expect(fetched.name).toEqual("Alchemy full credit grant");
    expect(fetched.effective_at).toEqual(JAN_1_2030);
    expect(fetched.expires_at).toEqual(JAN_1_2031);
    expect(fetched.priority).toEqual(10);
    expect(fetched.amount.monetary).toMatchObject({
      currency: "usd",
      value: 25_000,
    });
    // Both the user's metadata and alchemy's branding are present on the
    // live object; only the branding is stripped from the attribute.
    expect(fetched.metadata.contract).toEqual("ALCHEMY-TEST-FULL");
    expect(fetched.metadata[Stripe.ALCHEMY_ID_KEY]).toEqual("FullGrant");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "updating expiresAt and metadata is an in-place update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (props: {
        expiresAt?: number;
        metadata?: Record<string, string>;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const customer = yield* Stripe.Customer("UpdateGrantCustomer", {
              email: "update-grant@alchemy-test.example",
              name: "Update Grant Customer",
            });
            const grant = yield* Stripe.CreditGrant("UpdateGrant", {
              customerId: customer.customerId,
              amount: { monetary: { currency: "usd", value: 5000 } },
              applicabilityConfig: { scope: { priceType: "metered" } },
              name: "Alchemy updatable grant",
              ...props,
            });
            return { grant };
          }),
        );

      const initial = yield* deploy({
        expiresAt: JAN_1_2031,
        metadata: { tier: "bronze", drop: "me" },
      });
      expect(initial.grant.expiresAt).toEqual(JAN_1_2031);
      expect(initial.grant.metadata).toEqual({ tier: "bronze", drop: "me" });

      const updated = yield* deploy({
        expiresAt: JAN_1_2032,
        metadata: { tier: "gold" },
      });

      // In-place update: the id must be preserved.
      expect(updated.grant.creditGrantId).toEqual(initial.grant.creditGrantId);
      expect(updated.grant.expiresAt).toEqual(JAN_1_2032);
      // A removed metadata key is unset (Stripe blanks it with "").
      expect(updated.grant.metadata).toEqual({ tier: "gold" });

      const fetched = yield* GetBillingCreditGrantsId({
        id: updated.grant.creditGrantId,
      });
      expect(fetched.expires_at).toEqual(JAN_1_2032);
      expect(fetched.metadata.tier).toEqual("gold");
      expect(fetched.metadata.drop).toBeUndefined();
      // Branding survives the metadata update.
      expect(fetched.metadata[Stripe.ALCHEMY_ID_KEY]).toEqual("UpdateGrant");

      // Redeploying identical props must be a no-op that preserves the id.
      const again = yield* deploy({
        expiresAt: JAN_1_2032,
        metadata: { tier: "gold" },
      });
      expect(again.grant.creditGrantId).toEqual(initial.grant.creditGrantId);

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("changing an immutable prop replaces the grant", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = (priority: number) =>
      stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("ReplaceGrantCustomer", {
            email: "replace-grant@alchemy-test.example",
            name: "Replace Grant Customer",
          });
          const grant = yield* Stripe.CreditGrant("ReplaceGrant", {
            customerId: customer.customerId,
            amount: { monetary: { currency: "usd", value: 7500 } },
            applicabilityConfig: { scope: { priceType: "metered" } },
            priority,
          });
          return { grant };
        }),
      );

    const initial = yield* deploy(20);
    expect(initial.grant.priority).toEqual(20);

    // `priority` is not accepted by Stripe's update endpoint, so changing it
    // must force a replacement.
    const replaced = yield* deploy(30);
    expect(replaced.grant.creditGrantId).not.toEqual(
      initial.grant.creditGrantId,
    );
    expect(replaced.grant.priority).toEqual(30);

    // The replaced generation is voided, not deleted.
    const old = yield* GetBillingCreditGrantsId({
      id: initial.grant.creditGrantId,
    });
    expect(old.voided_at).not.toBeNull();

    const current = yield* GetBillingCreditGrantsId({
      id: replaced.grant.creditGrantId,
    });
    expect(current.voided_at).toBeNull();
    expect(current.priority).toEqual(30);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed credit grant", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { grant } = yield* stack.deploy(
      Effect.gen(function* () {
        const customer = yield* Stripe.Customer("ListGrantCustomer", {
          email: "list-grant@alchemy-test.example",
          name: "List Grant Customer",
        });
        const grant = yield* Stripe.CreditGrant("ListGrant", {
          customerId: customer.customerId,
          amount: { monetary: { currency: "usd", value: 1500 } },
          applicabilityConfig: { scope: { priceType: "metered" } },
        });
        return { grant };
      }),
    );

    const provider = yield* Provider.findProvider(Stripe.CreditGrant);
    const all = yield* provider.list();

    const found = all.find((g) => g.creditGrantId === grant.creditGrantId);
    expect(found).toBeDefined();
    expect(found?.customerId).toEqual(grant.customerId);
    expect(found?.amount.monetary).toMatchObject({
      currency: "usd",
      value: 1500,
    });

    yield* stack.destroy();

    // Voided grants are excluded from `list` — they are terminal and would
    // otherwise accumulate as permanent residue in account-wide teardown.
    const afterDestroy = yield* provider.list();
    expect(
      afterDestroy.find((g) => g.creditGrantId === grant.creditGrantId),
    ).toBeUndefined();
  }).pipe(logLevel),
);
