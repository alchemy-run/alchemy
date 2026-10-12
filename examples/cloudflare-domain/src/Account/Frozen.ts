import * as Domain from "alchemy/Domain";
import * as Schema from "effect/Schema";

/** The account is frozen. */
export class Frozen extends Domain.Rejection("Frozen", {
  data: { reason: Schema.String },
}) {}
