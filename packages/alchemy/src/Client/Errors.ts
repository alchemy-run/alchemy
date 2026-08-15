/**
 * Typed errors of the `alchemy/Client` bridge (`createClient`).
 *
 * The value form's in-process dispatch throws a backend method's typed
 * failure AS-IS (the real error instance) — these classes cover only the
 * protocol-level failures the client itself can produce.
 */

import * as Data from "effect/Data";

/**
 * A protocol-level failure raised by the in-process dispatch — most
 * notably the unknown-method rejection, tagged `RpcMethodNotFound`.
 *
 * The instance carries the payload's own enumerable properties — most
 * importantly `_tag`. Backend methods' own typed failures are NEVER
 * wrapped in this class: they throw/fail as their real instances.
 */
export class RpcError extends Error {
  _tag: string = "RpcError";
  constructor(payload: unknown) {
    const record =
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : undefined;
    super(
      typeof record?.message === "string"
        ? record.message
        : typeof record?._tag === "string"
          ? `the backend method failed with ${record._tag}`
          : "the backend method failed",
    );
    this.name = "RpcError";
    if (record !== undefined) {
      Object.assign(this, record);
    }
  }
}

/**
 * A backend method was called during prerender (a build-time world whose
 * resolved environment carries no `ALCHEMY_STACK_NAME` marker). Make the
 * page dynamic or move the call behind a request-time seam.
 */
export class RpcPrerenderError extends Data.TaggedError("RpcPrerenderError")<{
  method: string;
  message: string;
}> {}

/**
 * Everything the client itself can add to a method's failure channel (the
 * backend method's own typed failures ride alongside as their real
 * instances).
 */
export type RpcClientError = RpcError | RpcPrerenderError;
