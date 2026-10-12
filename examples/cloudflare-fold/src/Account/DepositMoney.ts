import { Command, Event } from "alchemy/Fold";
import { CustomerSession } from "../CustomerApi/CustomerSession.ts";
import { Cents } from "../Money.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

export class MoneyDeposited extends Event.make("MoneyDeposited", {
  data: { amount: Cents, balanceAfter: Cents },
}) {}

/** Pay money into an account. */
export class DepositMoney extends Command.make("DepositMoney", {
  target: AccountId,
  input: { amount: Cents },
  events: [MoneyDeposited],
  rejects: [NotOpen, NotOwner],
  reply: { balance: Cents },
}).middleware(CustomerSession) {}
