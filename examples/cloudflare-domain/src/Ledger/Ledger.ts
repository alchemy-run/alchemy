import * as Domain from "alchemy/Domain";
import { Account } from "../Account/Account.ts";
import { TransferCredited } from "../Account/CreditTransfer.ts";
import { TransferDebited } from "../Account/DebitTransfer.ts";
import { MoneyDeposited } from "../Account/DepositMoney.ts";
import { SettlementReceived } from "../Account/RecordSettlement.ts";
import { TransferRefunded } from "../Account/RefundTransfer.ts";
import { MoneyWithdrawn } from "../Account/WithdrawMoney.ts";

/** Every money movement, one row each, in a database outside the model. */
export class Ledger extends Domain.Projection("Ledger", {
  from: [Account],
  key: Account,
  on: [
    MoneyDeposited,
    MoneyWithdrawn,
    TransferDebited,
    TransferCredited,
    TransferRefunded,
    SettlementReceived,
  ],
}) {}
