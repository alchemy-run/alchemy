import { Command, Event, Rejection } from "alchemy/Fold";
import { Actor } from "../Actor.ts";
import { Cents } from "../Money.ts";
import { Frozen } from "./Frozen.ts";
import { InsufficientFunds } from "./InsufficientFunds.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

/** Daily withdrawal limit, in cents. */
export const DAILY_LIMIT = 100_000;

export class DailyLimitExceeded extends Rejection.make("DailyLimitExceeded", {
  data: { remaining: Cents },
}) {}

export class MoneyWithdrawn extends Event.make("MoneyWithdrawn", {
  data: { amount: Cents, balanceAfter: Cents },
}) {}

/** Take money out of an account, within the balance and the daily limit. */
export class Withdraw extends Command.make("Withdraw", {
  input: { amount: Cents, by: Actor },
  events: [MoneyWithdrawn],
  rejects: [NotOpen, NotOwner, Frozen, InsufficientFunds, DailyLimitExceeded],
  reply: { balance: Cents },
}) {}
