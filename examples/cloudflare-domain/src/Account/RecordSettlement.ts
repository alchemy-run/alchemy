import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";
import { Cents } from "../Money.ts";
import { AccountId } from "./AccountId.ts";

export class SettlementReceived extends Domain.Event("SettlementReceived", {
  data: { settlementId: Schema.String, amount: Cents, balanceAfter: Cents },
}) {}

/** Money settled on an account that is no longer open; `SettlementRefund` returns it. */
export class SettlementOnClosedAccount extends Domain.Event("SettlementOnClosedAccount", {
  data: { settlementId: Schema.String, amount: Cents },
}) {}

/** Reports a fact that already happened, so it never rejects. */
export class RecordSettlement extends Domain.Command("RecordSettlement", {
  target: AccountId,
  input: { settlementId: Schema.String, amount: Cents },
  events: [SettlementReceived, SettlementOnClosedAccount],
}) {}
