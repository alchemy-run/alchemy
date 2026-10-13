import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import { Account } from "./Account.ts";
import { AccountCard, CardChanged } from "./AccountCard.ts";
import { AccountSummary } from "./AccountSummary.ts";
import { TransferCredited } from "./CreditTransfer.ts";
import { TransferDebited } from "./DebitTransfer.ts";
import { MoneyDeposited } from "./DepositMoney.ts";
import { AccountFrozen } from "./FreezeAccount.ts";
import { SettlementReceived } from "./RecordSettlement.ts";
import { TransferRefunded } from "./RefundTransfer.ts";
import { MoneyWithdrawn } from "./WithdrawMoney.ts";

/**
 * Appends a new card whenever an account's summary changes: each input
 * arrives with the summary's state after it.
 */
export class AccountCards extends Domain.Projection("AccountCards", {
  from: [AccountSummary],
  key: Account,
  on: [
    MoneyDeposited,
    MoneyWithdrawn,
    TransferDebited,
    TransferCredited,
    TransferRefunded,
    SettlementReceived,
    AccountFrozen,
  ],
  writes: [AccountCard],
}) {}

export const AccountCardsLive = AccountCards.toLayer(
  Effect.gen(function* () {
    const cards = yield* AccountCard;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        const summary = input.state;
        if (!summary?.customerId || !summary.owner) continue;
        yield* cards.append(
          input,
          new CardChanged({
            customerId: summary.customerId,
            owner: summary.owner,
            balance: summary.balance,
            frozen: summary.frozen,
          }),
        );
      }
    });
  }),
);
