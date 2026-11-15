import * as Domain from "@alchemy.run/domain";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/Transfer.id.ts";
import { AccountId } from "./Account.id.ts";

export class TransferRefunded extends Domain.Event("TransferRefunded", {
  transferId: TransferId,
  amount: Cents,
  balanceAfter: Cents,
}) {}

/**
 * Give a debited amount back when its credit failed. Sent by
 * `ExecuteTransfer` as the debit's compensation, so it never rejects.
 */
export class RefundTransfer extends Domain.Command("RefundTransfer", {
  target: AccountId,
  input: { transferId: TransferId, amount: Cents },
  events: [TransferRefunded],
}) {}
