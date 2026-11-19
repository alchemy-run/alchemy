import * as Domain from "@alchemy.run/domain";
import { Bank } from "./Bank.model.ts";

/**
 * What customers reach: commands to change things and views to read.
 * Each entry authorizes itself, through its `decide` or `validate`.
 */
export class CustomerApi extends Domain.Api("CustomerApi", {
  model: Bank,
  commands: ["OpenAccount", "DepositMoney", "WithdrawMoney", "RequestTransfer"],
  views: ["AccountSummary", "TransferStatus"],
}) {}
