import * as Domain from "alchemy/Domain";
import { Cents } from "../Money.ts";
import { TransferId } from "../Transfer/TransferId.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";

export class TransferCredited extends Domain.Event("TransferCredited", {
  transferId: TransferId,
  amount: Cents,
  balanceAfter: Cents,
}) {}

/** Pay a transfer's amount into the destination account. */
export class CreditTransfer extends Domain.Command("CreditTransfer", {
  target: AccountId,
  input: { transferId: TransferId, amount: Cents },
  events: [TransferCredited],
  rejects: [NotOpen],
}) {}
