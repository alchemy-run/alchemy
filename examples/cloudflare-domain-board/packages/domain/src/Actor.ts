import * as Schema from "effect/Schema";

/**
 * Who is acting: a person (`sam`) or an agent (`reviewer`). The `Session`
 * middleware reads it from each request; events record it as `by` or `author`.
 */
export const ActorName = Schema.String.pipe(Schema.brand("ActorName"));
export type ActorName = typeof ActorName.Type;
