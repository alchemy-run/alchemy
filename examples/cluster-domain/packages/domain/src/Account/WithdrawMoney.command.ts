import * as Domain from "@alchemy.run/domain";
import { Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";
import { InsufficientFunds } from "./InsufficientFunds.rejection.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {
  amount: Cents,
  balanceAfter: Cents,
}) {}

/** Take money out of one of your accounts. */
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
  target: AccountId,
  middleware: [Session],
  input: { amount: Cents },
  events: [MoneyWithdrawn],
  rejects: [NotOpen, NotOwner, InsufficientFunds],
  reply: { balance: Cents },
}) {}
