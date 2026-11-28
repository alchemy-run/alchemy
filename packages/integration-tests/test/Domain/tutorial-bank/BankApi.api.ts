import * as Domain from "@alchemy.run/domain";
import { Bank } from "./Bank.model.ts";

export class BankApi extends Domain.Api("BankApi", {
  model: Bank,
  commands: ["RegisterCustomer", "DepositMoney", "WithdrawMoney"],
  views: ["AccountSummary"],
}) {}
