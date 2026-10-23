import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

export class ExecuteTransfer extends Domain.Saga("ExecuteTransfer", {
  key: Schema.String,
  input: { amount: Schema.Int },
  rejects: [],
}) {}
