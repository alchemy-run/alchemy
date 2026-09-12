/**
 * The typed failure of every Discord API binding ({@link ListMessages},
 * {@link CreateMessage}, …). Bindings that can answer a request with a
 * domain fact fail with their own tagged error instead —
 * `DiscordApiError` is the wire-level failure (auth, rate limit,
 * permissions, network).
 */
import * as Data from "effect/Data";

export class DiscordApiError extends Data.TaggedError("Discord.ApiError")<{
  /** The operation, e.g. `channels.listMessages`. */
  readonly operation: string;
  /** HTTP status when the API answered at all. */
  readonly status?: number;
  readonly message: string;
}> {}
