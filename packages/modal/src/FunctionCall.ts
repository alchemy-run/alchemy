import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

/** Paths Alchemy's entrypoint posts calls to. */
export const CALL_PATH = "/__modal/call";
export const SCHEDULE_PATH = "/__modal/schedule";

/** One input of a `Modal.Function`, as its program receives it. */
export interface FunctionCall {
  /** Positional arguments (bytes arrive base64-encoded). */
  readonly args: ReadonlyArray<unknown>;
  /** Keyword arguments. */
  readonly kwargs: Record<string, unknown>;
  /** `true` for a tick of the function's `schedule`. */
  readonly scheduled: boolean;
  /** Modal's id for the call (`fc-…`). */
  readonly functionCallId: string | undefined;
}

/**
 * The Modal call the current request carries, or `undefined` when it isn't
 * one. A `Modal.Function` program receives every call as an HTTP request
 * from Alchemy's entrypoint; respond with JSON (the call's result) or an
 * error status (the call fails with the response body).
 *
 * @example
 * ```ts
 * fetch: Effect.gen(function* () {
 *   const call = yield* Modal.FunctionCall;
 *   if (call === undefined) return HttpServerResponse.text("not a call", { status: 404 });
 *   const [text] = call.args as [string];
 *   return yield* HttpServerResponse.json({ length: text.length });
 * })
 * ```
 */
export const FunctionCall = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const path = new URL(request.url, "http://localhost").pathname;
  if (request.method !== "POST" || (path !== CALL_PATH && path !== SCHEDULE_PATH)) {
    return undefined;
  }
  const body = (yield* request.json) as {
    readonly args?: ReadonlyArray<unknown>;
    readonly kwargs?: Record<string, unknown>;
  } | null;
  const id = request.headers["x-modal-function-call-id"];
  return {
    args: body?.args ?? [],
    kwargs: body?.kwargs ?? {},
    scheduled: path === SCHEDULE_PATH,
    functionCallId: typeof id === "string" ? id : undefined,
  } satisfies FunctionCall;
});
