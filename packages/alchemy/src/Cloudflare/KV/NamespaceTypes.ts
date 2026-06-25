import * as Data from "effect/Data";

export class KVNamespaceError extends Data.TaggedError("KVNamespaceError")<{
  message: string;
  cause: Error;
}> {}
