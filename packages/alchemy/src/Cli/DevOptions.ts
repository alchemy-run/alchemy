import * as Schema from "effect/Schema";

/** Wire format passed from the `alchemy dev` supervisor to its exec child. */
export const DevOptions = Schema.Struct({
  main: Schema.String,
  stage: Schema.String,
  envFile: Schema.OptionFromOptional(Schema.String),
  profile: Schema.optional(Schema.String),
  force: Schema.Boolean,
});

export type DevOptions = typeof DevOptions.Type;
