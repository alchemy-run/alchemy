/**
 * The argument codec every JSON RPC transport shares. It lives apart from
 * `Rpc.ts` so a runtime with a tight bundle budget (Railway canvas Functions)
 * can import it without the stream and socket transports.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class RpcDecodeError extends Data.TaggedError("RpcDecodeError")<{
  readonly cause: unknown;
}> {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

/**
 * Stands in for an `undefined` argument on the wire. JSON has no `undefined`:
 * inside an array it becomes `null`, so a method called `list(path, undefined)`
 * would otherwise receive `list(path, null)` on the other side.
 */
const UNDEFINED_ARG = { "~alchemy/rpc": "undefined" } as const;

const isUndefinedArg = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  (value as Record<string, unknown>)["~alchemy/rpc"] === "undefined";

/**
 * Encode a method's arguments for a JSON transport, keeping an `undefined`
 * argument `undefined` on the other side. Trailing `undefined` arguments are
 * left off, which a callee on any version reads as `undefined`; one followed
 * by a defined argument goes as a marker that {@link decodeRpcArgs} restores.
 * Properties set to `undefined` inside an argument are dropped by JSON, which
 * the callee reads as `undefined` too.
 */
export const encodeRpcArgs = (args: ReadonlyArray<unknown>): string => {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  return JSON.stringify(args.slice(0, end).map((arg) => (arg === undefined ? UNDEFINED_ARG : arg)));
};

/**
 * Decode arguments encoded by {@link encodeRpcArgs} (or by a plain
 * `JSON.stringify(args)`). An empty body is no arguments; anything other than
 * a JSON array fails with {@link RpcDecodeError}.
 */
export const decodeRpcArgs = (text: string): Effect.Effect<Array<unknown>, RpcDecodeError> =>
  Effect.try({
    try: (): unknown => (text.length > 0 ? JSON.parse(text) : []),
    catch: (cause) => new RpcDecodeError({ cause }),
  }).pipe(
    Effect.flatMap((args) =>
      Array.isArray(args)
        ? Effect.succeed(args.map((arg) => (isUndefinedArg(arg) ? undefined : arg)))
        : Effect.fail(new RpcDecodeError({ cause: "RPC arguments must be a JSON array" })),
    ),
  );
