import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { AccountId } from "./Account.id.ts";
import { NotOpen } from "./NotOpen.rejection.ts";

export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", { amount: Schema.Int }) {}

export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
  target: AccountId,
  input: { amount: Schema.Int },
  events: [MoneyWithdrawn],
  rejects: [NotOpen],
}) {}
