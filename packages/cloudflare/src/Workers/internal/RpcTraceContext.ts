import * as Headers from "effect/http/Headers";
import * as HttpTraceContext from "effect/http/HttpTraceContext";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

/**
 * Key of the trailing argument Durable Object RPC stubs appended to carry the
 * caller's W3C `traceparent`, before calls carried their metadata in the
 * protocol envelope (`~alchemy/rpc`). Stubs no longer send it; bridges keep
 * stripping it so calls from isolates still on older code arrive intact.
 */
const TRACEPARENT_KEY = "~alchemy/traceparent";

interface TraceContextArg {
  readonly [TRACEPARENT_KEY]: string;
}

// Checked on every call's last argument, which is often a large payload: test
// the key before counting keys, since `Object.keys` of a multi-megabyte
// `Uint8Array` allocates a string per byte and exhausts the isolate's memory.
const isTraceContextArg = (value: unknown): value is TraceContextArg =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype &&
  typeof (value as Record<string, unknown>)[TRACEPARENT_KEY] === "string" &&
  Object.keys(value).length === 1;

/**
 * Split the trace context an older stub appended off an RPC call's arguments.
 * Calls without it pass through untouched.
 */
export const takeRpcTraceContext = (
  args: ReadonlyArray<unknown>,
): readonly [args: ReadonlyArray<unknown>, parent: Option.Option<Tracer.ExternalSpan>] => {
  const last = args.at(-1);
  if (!isTraceContextArg(last)) return [args, Option.none()];
  return [
    args.slice(0, -1),
    HttpTraceContext.w3c(Headers.fromRecordUnsafe({ traceparent: last[TRACEPARENT_KEY] })),
  ];
};
