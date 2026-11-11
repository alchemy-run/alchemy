import * as Schema from "effect/Schema";

/** An amount of money in cents. */
export const Cents = Schema.Int;

/** An amount of money a command moves: more than nothing. */
export const Amount = Cents.check(Schema.isGreaterThan(0));
