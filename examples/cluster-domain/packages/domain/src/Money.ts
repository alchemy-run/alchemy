import * as Schema from "effect/Schema";

/** An amount of money in cents. */
export const Cents = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
