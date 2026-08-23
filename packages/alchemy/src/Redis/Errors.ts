import * as Data from "effect/Data";

/** No `REDIS_URL` in the Function/Service environment. */
export class UrlMissing extends Data.TaggedError("Redis.UrlMissing")<{
  name: string;
}> {}

/** A Redis command failed (RESP error, socket, or Bun client). */
export class CommandError extends Data.TaggedError("Redis.CommandError")<{
  command: string;
  cause: unknown;
}> {}
