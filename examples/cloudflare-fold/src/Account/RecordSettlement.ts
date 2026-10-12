import { Command, Event } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";
import { AccountId } from "./AccountId.ts";

export class SettlementReceived extends Event.make("SettlementReceived", {
  data: { settlementId: Schema.String, amount: Cents, balanceAfter: Cents },
}) {}

/** Money settled on an account that is no longer open; `SettlementRefund` returns it. */
export class SettlementOnClosedAccount extends Event.make("SettlementOnClosedAccount", {
  data: { settlementId: Schema.String, amount: Cents },
}) {}

/** Reports a fact that already happened, so it never rejects. */
export class RecordSettlement extends Command.make("RecordSettlement", {
  target: AccountId,
  input: { settlementId: Schema.String, amount: Cents },
  events: [SettlementReceived, SettlementOnClosedAccount],
}) {}
