import { Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";

/** The account is frozen. */
export class Frozen extends Rejection.make("Frozen", {
  data: { reason: Schema.String },
}) {}
