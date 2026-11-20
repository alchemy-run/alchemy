import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThinEventObject } from "../Events.ts";

const ThinEventSchema = Schema.Struct({
  id: Schema.String,
  created: Schema.String,
  livemode: Schema.Boolean,
  related_object: Schema.Struct({
    id: Schema.String,
    type: Schema.String,
    url: Schema.String,
  }).pipe(Schema.NullOr, Schema.optional),
  data: Schema.optional(Schema.Unknown),
  context: Schema.String.pipe(Schema.NullOr, Schema.optional),
});

export const decodeThinEvent = (
  event: unknown,
): Effect.Effect<ThinEventObject, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(ThinEventSchema)(event).pipe(
    Effect.map((decoded) => ({
      id: decoded.id,
      created: decoded.created,
      livemode: decoded.livemode,
      relatedObject: decoded.related_object ?? undefined,
      data: decoded.data,
      context: decoded.context ?? undefined,
    })),
  );
