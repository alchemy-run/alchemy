import * as Schema from "effect/Schema";

/** A user's id, as yielded assigns it. */
export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;
