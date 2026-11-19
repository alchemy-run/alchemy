import * as Schema from "effect/Schema";

/** A channel on the board, such as `dev` or `security/incidents`. */
export const ChannelId = Schema.String.pipe(Schema.brand("ChannelId")).annotate({
  description: "A channel, such as dev or security/incidents",
});
export type ChannelId = typeof ChannelId.Type;
