import * as Domain from "@alchemy.run/domain";
import { Amount, Cents } from "../Money.ts";
import { Session } from "../Session.middleware.ts";
import { AccountId } from "./Account.id.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { NotOwner } from "./NotOwner.rejection.ts";

export class MoneyDeposited extends Domain.Event("MoneyDeposited", {
  amount: Cents,
  balanceAfter: Cents,
}) {}

/** Pay money into an account. */
export class DepositMoney extends Domain.Command("DepositMoney", {
  middleware: [Session],
  input: { accountId: AccountId, amount: Amount },
  events: [MoneyDeposited],
  rejects: [NotOpen, NotOwner],
  reply: { balance: Cents },
}) {}
