import { Rejection } from "alchemy/Fold";
import * as Schema from "effect/Schema";

/** The caller may not read or do this. */
export class Forbidden extends Rejection.make("Forbidden", {
  data: { reason: Schema.String },
}) {}
