import { Command, Event, Rejection } from "alchemy/Fold";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

/** Only an empty account can be closed. */
export class BalanceNotZero extends Rejection.make("BalanceNotZero", {
  data: { balance: Cents },
}) {}

export class AccountClosed extends Event.make("AccountClosed") {}

/** Close an empty account. */
export class CloseAccount extends Command.make("CloseAccount", {
  input: { by: Actor },
  events: [AccountClosed],
  rejects: [NotOpen, NotOwner, BalanceNotZero],
}) {}
