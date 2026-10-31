import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class ScoreUnavailable extends Domain.Rejection("ScoreUnavailable") {}

export class FraudCheck extends Domain.ExternalSystem("FraudCheck", {
  score: {
    args: { accountId: Schema.String },
    success: { risk: Schema.Number },
    error: ScoreUnavailable,
  },
}) {}
