import * as Domain from "alchemy/Domain";
import { MfaChallenge } from "../MfaChallenge.ts";
import { Cents } from "../Money.ts";
import { Session } from "../Session.ts";
import { AccountId } from "./AccountId.ts";
import { Frozen } from "./Frozen.ts";
import { InsufficientFunds } from "./InsufficientFunds.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

/** Daily withdrawal limit, in cents. */
export const DAILY_LIMIT = 100_000;

export class DailyLimitExceeded extends Domain.Rejection("DailyLimitExceeded", {
  remaining: Cents,
}) {}

export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {
  amount: Cents,
  balanceAfter: Cents,
}) {}

/** Take money out of an account, within the balance and the daily limit. */
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
  target: AccountId,
  middleware: [Session, MfaChallenge],
  input: { amount: Cents },
  events: [MoneyWithdrawn],
  rejects: [NotOpen, NotOwner, Frozen, InsufficientFunds, DailyLimitExceeded],
  reply: { balance: Cents },
}) {}
