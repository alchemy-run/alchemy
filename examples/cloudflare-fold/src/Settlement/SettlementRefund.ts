import { Policy } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import { Account, SettlementOnClosedAccount } from "../Account/Account.ts";
import { Payments } from "./Payments.ts";

/** Whenever money settles on a closed account, refund it. */
export class SettlementRefund extends Policy.make("SettlementRefund", {
  from: Account,
  on: [SettlementOnClosedAccount],
}) {}

export const SettlementRefundLive = SettlementRefund.toLayer(
  Effect.gen(function* () {
    const payments = yield* Payments;
    return Effect.fn(function* ({ event }) {
      yield* payments.refund({ settlementId: event.settlementId, amount: event.amount });
    });
  }),
);
