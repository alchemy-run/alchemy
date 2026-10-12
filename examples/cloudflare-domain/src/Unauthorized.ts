import * as Schema from "effect/Schema";

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
