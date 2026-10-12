import * as Domain from "alchemy/Domain";
import { Cents } from "../Money.ts";
import { Session } from "../Session.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

export class MoneyDeposited extends Domain.Event("MoneyDeposited", {
  data: { amount: Cents, balanceAfter: Cents },
}) {}

/** Pay money into an account. */
export class DepositMoney extends Domain.Command("DepositMoney", {
  target: AccountId,
  middleware: [Session],
  input: { amount: Cents },
  events: [MoneyDeposited],
  rejects: [NotOpen, NotOwner],
  reply: { balance: Cents },
}) {}
