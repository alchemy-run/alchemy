import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetIssuingCardsCard,
  PostIssuingCardsCard,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Issuing is an entitlement — a plain Stripe test account cannot issue cards
 * until Issuing is enabled on it. Set `STRIPE_TEST_ISSUING=1` on an entitled
 * account to run the full lifecycle.
 */
const issuing = test.provider.skipIf(!process.env.STRIPE_TEST_ISSUING);

/**
 * Every value below is deliberately synthetic: the `203.0.113.0/24`
 * (TEST-NET-3) address block is reserved for documentation and the postal
 * address is a well-known placeholder. Never put realistic personal data in a
 * test that talks to a live API.
 */
const BILLING = {
  address: {
    line1: "123 Fake Street",
    city: "San Francisco",
    state: "CA",
    postalCode: "94103",
    country: "US",
  },
} as const;

/**
 * Celtic's Authorized User Terms must be accepted before a US card can be
 * activated. The timestamp is a fixed constant so the test is deterministic.
 */
const TERMS_ACCEPTANCE = {
  date: 1_680_000_000,
  ip: "203.0.113.10",
} as const;

const cardholder = (id: string, name: string) =>
  Stripe.IssuingCardholder(id, {
    name,
    type: "individual",
    billing: BILLING,
    individual: {
      firstName: "Alchemy",
      lastName: "Tester",
      termsAcceptance: TERMS_ACCEPTANCE,
    },
  });

issuing(
  "issue a virtual card with the minimum props and cancel it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const card = yield* stack.deploy(
        Effect.gen(function* () {
          const holder = yield* cardholder(
            "MinimalCardHolder",
            "Alchemy Card Minimal",
          );
          return yield* Stripe.IssuingCard("MinimalCard", {
            cardholderId: holder.cardholderId,
            currency: "usd",
            type: "virtual",
          });
        }),
      );

      expect(card.cardId).toBeDefined();
      expect(card.cardId.startsWith("ic_")).toBe(true);
      expect(card.type).toEqual("virtual");
      expect(card.currency).toEqual("usd");
      // Stripe defaults a new card to `inactive`.
      expect(card.status).toEqual("inactive");
      expect(card.last4).toHaveLength(4);
      expect(card.brand).toBeDefined();
      expect(card.expMonth).toBeGreaterThan(0);
      expect(card.expYear).toBeGreaterThan(2000);
      expect(card.metadata).toEqual({});

      const fetched = yield* GetIssuingCardsCard({ card: card.cardId });
      expect(fetched.id).toEqual(card.cardId);
      expect(fetched.cardholder.id).toEqual(card.cardholderId);
      expect(fetched.metadata.alchemy_id).toEqual("MinimalCard");

      yield* stack.destroy();

      // Stripe cannot delete a card — destroy cancels it, terminally.
      const afterDestroy = yield* GetIssuingCardsCard({ card: card.cardId });
      expect(afterDestroy.id).toEqual(card.cardId);
      expect(afterDestroy.status).toEqual("canceled");
    }),
  { timeout: 180_000 },
);

issuing(
  "issue a fully configured active card",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const card = yield* stack.deploy(
        Effect.gen(function* () {
          const holder = yield* cardholder(
            "FullCardHolder",
            "Alchemy Card Full",
          );
          return yield* Stripe.IssuingCard("FullCard", {
            cardholderId: holder.cardholderId,
            currency: "usd",
            type: "virtual",
            status: "active",
            spendingControls: {
              allowedCategories: ["computer_software_stores"],
              spendingLimits: [{ amount: 100_000, interval: "monthly" }],
            },
            metadata: { costCenter: "eng-tools" },
          });
        }),
      );

      expect(card.status).toEqual("active");
      expect(card.metadata).toEqual({ costCenter: "eng-tools" });
      expect(card.spendingControls?.allowedCategories).toEqual([
        "computer_software_stores",
      ]);
      expect(card.spendingControls?.spendingLimits).toEqual([
        { amount: 100_000, interval: "monthly" },
      ]);
      // The PAN and CVC are deliberately not modelled.
      expect(card).not.toHaveProperty("number");
      expect(card).not.toHaveProperty("cvc");

      const fetched = yield* GetIssuingCardsCard({ card: card.cardId });
      expect(fetched.status).toEqual("active");
      expect(fetched.spending_controls.spending_limits).toEqual([
        { amount: 100_000, categories: null, interval: "monthly" },
      ]);
      expect(fetched.metadata.costCenter).toEqual("eng-tools");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

issuing(
  "update a card in place without changing its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (props: {
        status: "active" | "inactive";
        spendingControls?: Stripe.IssuingCardSpendingControls;
        metadata: Record<string, string>;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const holder = yield* cardholder(
              "MutableCardHolder",
              "Alchemy Card Mutable",
            );
            return yield* Stripe.IssuingCard("MutableCard", {
              cardholderId: holder.cardholderId,
              currency: "usd",
              type: "virtual",
              ...props,
            });
          }),
        );

      const created = yield* deploy({
        status: "inactive",
        metadata: { phase: "before" },
      });
      expect(created.status).toEqual("inactive");

      const updated = yield* deploy({
        status: "active",
        spendingControls: {
          spendingLimits: [{ amount: 5_000, interval: "daily" }],
        },
        metadata: { phase: "after" },
      });

      // `status`, `spendingControls` and `metadata` are all mutable, so the
      // card is patched in place and keeps its number.
      expect(updated.cardId).toEqual(created.cardId);
      expect(updated.last4).toEqual(created.last4);
      expect(updated.status).toEqual("active");
      expect(updated.metadata).toEqual({ phase: "after" });
      expect(updated.spendingControls?.spendingLimits).toEqual([
        { amount: 5_000, interval: "daily" },
      ]);

      const fetched = yield* GetIssuingCardsCard({ card: updated.cardId });
      expect(fetched.status).toEqual("active");
      expect(fetched.metadata.phase).toEqual("after");
      expect(fetched.metadata.alchemy_id).toEqual("MutableCard");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

issuing(
  "replace the card when an immutable prop changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both cardholders stay deployed across the two steps: replacing a
      // resource while simultaneously removing its old dependency deadlocks
      // the engine.
      const deploy = (holder: "A" | "B") =>
        stack.deploy(
          Effect.gen(function* () {
            const first = yield* cardholder(
              "ReplacedCardHolderA",
              "Alchemy Card Holder A",
            );
            const second = yield* cardholder(
              "ReplacedCardHolderB",
              "Alchemy Card Holder B",
            );
            const card = yield* Stripe.IssuingCard("ReplacedCard", {
              cardholderId:
                holder === "A" ? first.cardholderId : second.cardholderId,
              currency: "usd",
              type: "virtual",
            });
            return { card, first, second };
          }),
        );

      const before = yield* deploy("A");
      expect(before.card.cardholderId).toEqual(before.first.cardholderId);

      const after = yield* deploy("B");

      // `cardholderId` is immutable, so the card is replaced — and the old
      // generation is canceled, irreversibly.
      expect(after.card.cardId).not.toEqual(before.card.cardId);
      expect(after.card.cardholderId).toEqual(after.second.cardholderId);

      const old = yield* GetIssuingCardsCard({ card: before.card.cardId });
      expect(old.status).toEqual("canceled");

      const current = yield* GetIssuingCardsCard({ card: after.card.cardId });
      expect(current.status).toEqual("inactive");
      expect(current.cardholder.id).toEqual(after.second.cardholderId);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

issuing(
  "a canceled card is replaced rather than revived",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = () =>
        stack.deploy(
          Effect.gen(function* () {
            const holder = yield* cardholder(
              "CanceledCardHolder",
              "Alchemy Card Canceled",
            );
            return yield* Stripe.IssuingCard("CanceledCard", {
              cardholderId: holder.cardholderId,
              currency: "usd",
              type: "virtual",
              status: "active",
            });
          }),
        );

      const created = yield* deploy();
      expect(created.status).toEqual("active");

      // Cancel the card out of band, as an operator would from the
      // dashboard. Cancellation is terminal — the card can never go back to
      // `active`.
      yield* PostIssuingCardsCard({
        card: created.cardId,
        status: "canceled",
      });

      // Redeploying the same props issues a brand-new card: `read` observes
      // the canceled status and `diff` plans a replacement rather than a
      // doomed patch back to `active`.
      const reissued = yield* deploy();
      expect(reissued.cardId).not.toEqual(created.cardId);
      expect(reissued.status).toEqual("active");

      const old = yield* GetIssuingCardsCard({ card: created.cardId });
      expect(old.status).toEqual("canceled");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
