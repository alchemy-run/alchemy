import * as Domain from "alchemy/Domain";
import { Account } from "../Account/Account.ts";
import { AccountCard } from "../Account/AccountCard.ts";
import { AccountSummary } from "../Account/AccountSummary.ts";
import { CloseAccount } from "../Account/CloseAccount.ts";
import { DepositMoney } from "../Account/DepositMoney.ts";
import { Statement } from "../Account/Statement.ts";
import { WithdrawMoney } from "../Account/WithdrawMoney.ts";
import { CustomerDashboard } from "../Customer/CustomerDashboard.ts";
import { RegisterCustomer } from "../Customer/RegisterCustomer.ts";
import { AccountTransfers } from "../Transfer/AccountTransfers.ts";
import { RequestTransfer } from "../Transfer/RequestTransfer.ts";
import { TransferStatus } from "../Transfer/TransferStatus.ts";

/**
 * What the customer app reaches: commands to change things, and the Account
 * aggregate and views to read and watch. Each entry authorizes itself,
 * through its `decide` or `validate`.
 */
export class CustomerApi extends Domain.Api(
  "CustomerApi",
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
) {}
