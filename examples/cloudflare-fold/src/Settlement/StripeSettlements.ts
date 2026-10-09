import * as Stripe from "alchemy/Stripe";
import * as Effect from "effect/Effect";
import { Account, RecordSettlement } from "../Account/Account.ts";
import { AccountId } from "../Account/AccountId.ts";

/**
 * Card top-ups settle through Stripe. Every `payment_intent.succeeded` whose
 * metadata names an account becomes a `RecordSettlement`, a command that
 * never rejects (money that settled on a closed account is refunded by
 * `SettlementRefund`).
 *
 * `consumeEvents` provisions the Stripe webhook endpoint pointed at this
 * Worker, binds its signing secret, and verifies every delivery. The payment
 * intent id is the command id, so a redelivered event is a no-op.
 */
export const StripeSettlements = Effect.gen(function* () {
  const accounts = yield* Account;
  yield* Stripe.consumeEvents(
    "Settlements",
    { events: [Stripe.PaymentIntentSucceeded] },
    Effect.fn(function* (event) {
      const intent = event.object;
      const accountId = intent.metadata?.accountId;
      if (!accountId) return;
      yield* accounts.send(
        AccountId.make(accountId),
        new RecordSettlement({ settlementId: intent.id, amount: intent.amount_received }),
        { commandId: `settlement:${intent.id}` },
      );
    }),
  );
});
