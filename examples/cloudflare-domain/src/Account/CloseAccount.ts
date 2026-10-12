import * as Domain from "alchemy/Domain";
import { Cents } from "../Money.ts";
import { Session } from "../Session.ts";
import { AccountId } from "./AccountId.ts";
import { NotOpen } from "./NotOpen.ts";
import { NotOwner } from "./NotOwner.ts";

/** Only an empty account can be closed. */
export class BalanceNotZero extends Domain.Rejection("BalanceNotZero", {
  data: { balance: Cents },
}) {}

export class AccountClosed extends Domain.Event("AccountClosed") {}

/** Close an empty account. */
export class CloseAccount extends Domain.Command("CloseAccount", {
  target: AccountId,
  middleware: [Session],
  events: [AccountClosed],
  rejects: [NotOpen, NotOwner, BalanceNotZero],
}) {}
