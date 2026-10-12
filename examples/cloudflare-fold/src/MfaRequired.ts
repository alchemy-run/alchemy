import * as Schema from "effect/Schema";

export class MfaRequired extends Schema.TaggedError<MfaRequired>()("MfaRequired", {}) {}
