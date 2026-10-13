import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";
import { AccountId } from "../Account/AccountId.ts";
import { Cents } from "../Money.ts";

/** The external fraud-scoring system. */
export class FraudCheck extends Domain.ExternalSystem("FraudCheck", {
  score: { args: { accountId: AccountId, amount: Cents }, success: { risk: Schema.Number } },
}) {}
