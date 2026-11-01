import * as Data from "effect/Data";

/** No `REDIS_URL` in the Function/Service environment. */
export class UrlMissing extends Data.TaggedError("Redis.UrlMissing")<{
  resourceName: string;
  /** Why the value that is there can't be used. It must not quote the URL's secrets. */
  reason?: string;
}> {
  override get message() {
    return this.reason === undefined
      ? `REDIS_URL missing for ${this.resourceName}`
      : `No usable Redis URL for ${this.resourceName}: ${this.reason}`;
  }
}

/** A Redis command failed (RESP error, socket, or protocol). */
export class CommandError extends Data.TaggedError("Redis.CommandError")<{
  command: string;
  cause: unknown;
}> {}

/** Redis replied with a RESP error (`-ERR …`, `-WRONGTYPE …`). */
export class ReplyError extends Data.TaggedError("Redis.ReplyError")<{
  readonly code: string;
  readonly message: string;
}> {}

/** Bytes on the wire were not valid RESP. */
export class ProtocolError extends Data.TaggedError("Redis.ProtocolError")<{
  readonly message: string;
}> {}
