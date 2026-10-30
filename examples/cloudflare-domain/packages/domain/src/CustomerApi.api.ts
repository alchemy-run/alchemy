import * as Domain from "@alchemy.run/domain";
import { Account } from "./Account/Account.aggregate.ts";
import { AccountCard } from "./Account/AccountCard.stream.ts";
import { AccountSummary } from "./Account/AccountSummary.view.ts";
import { CloseAccount } from "./Account/CloseAccount.command.ts";
import { DepositMoney } from "./Account/DepositMoney.command.ts";
import { Statement } from "./Account/Statement.view.ts";
import { WithdrawMoney } from "./Account/WithdrawMoney.command.ts";
import { Bank } from "./Bank.model.ts";
import { CustomerDashboard } from "./Customer/CustomerDashboard.view.ts";
import { RegisterCustomer } from "./Customer/RegisterCustomer.command.ts";
import { AccountTransfers } from "./Transfer/AccountTransfers.view.ts";
import { RequestTransfer } from "./Transfer/RequestTransfer.command.ts";
import { TransferStatus } from "./Transfer/TransferStatus.view.ts";

/**
 * What the customer app reaches: commands to change things, and the Account
 * aggregate and views to read and watch. Each entry authorizes itself,
 * through its `decide` or `validate`.
 */
export class CustomerApi extends Domain.Api("CustomerApi", {
  model: Bank,
  serves: [
    RegisterCustomer,
    DepositMoney,
    WithdrawMoney,
    CloseAccount,
    RequestTransfer,
    Account,
    CustomerDashboard,
    AccountSummary,
    AccountCard,
    Statement,
    AccountTransfers,
    TransferStatus,
  ],
}) {}
