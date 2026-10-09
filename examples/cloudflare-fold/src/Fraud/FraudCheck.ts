import { Port } from "alchemy/Fold";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/AccountId.ts";
import { Cents } from "../Money.ts";

/** The external fraud-scoring system. */
export class FraudCheck extends Port.make("FraudCheck", {
  score: { args: { accountId: AccountId, amount: Cents }, success: { risk: Schema.Number } },
}) {}
