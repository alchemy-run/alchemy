import { Command, Event, Rejection } from "alchemy/Fold";
import { CustomerSession } from "../CustomerApi/CustomerSession.ts";
import { Cents } from "../Money.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

/** Only an empty account can be closed. */
export class BalanceNotZero extends Rejection.make("BalanceNotZero", {
  data: { balance: Cents },
}) {}

export class AccountClosed extends Event.make("AccountClosed") {}

/** Close an empty account. */
export class CloseAccount extends Command.make("CloseAccount", {
  target: AccountId,
  events: [AccountClosed],
  rejects: [NotOpen, NotOwner, BalanceNotZero],
}).middleware(CustomerSession) {}
