import { Command, Event } from "alchemy/Fold";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

export class MoneyDeposited extends Event.make("MoneyDeposited", {
  data: { amount: Cents, balanceAfter: Cents },
}) {}

/** Pay money into an account. */
export class Deposit extends Command.make("Deposit", {
  input: { amount: Cents, by: Actor },
  events: [MoneyDeposited],
  rejects: [NotOpen, NotOwner],
  reply: { balance: Cents },
}) {}
