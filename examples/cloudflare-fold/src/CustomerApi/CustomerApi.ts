import { Api } from "alchemy/Fold";
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
 * What the customer app reaches: commands to change things and views to read
 * and watch. Each entry authorizes itself, through its `decide` or `validate`.
 */
export class CustomerApi extends Api.make(
  "CustomerApi",
  RegisterCustomer,
  DepositMoney,
  WithdrawMoney,
  CloseAccount,
  RequestTransfer,
  CustomerDashboard,
  AccountSummary,
  Statement,
  AccountTransfers,
  TransferStatus,
) {}
