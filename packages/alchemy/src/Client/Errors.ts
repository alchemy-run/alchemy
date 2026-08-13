/**
 * Typed errors of the `alchemy/client` bridge (`createClient`).
 *
 * These are the client-side halves of the wire protocol defined in
 * `Serve/Rpc.ts`: the decoded envelope failures plus the world/transport
 * errors the client itself can produce. This module is part of the shared
 * (browser-safe) client surface — it must never import server-only
 * modules.
 */

import * as Data from "effect/Data";

/**
 * A typed failure decoded from the `{"error": ...}` wire envelope (or
 * raised by the in-process dispatch for protocol-level failures like an
 * unknown method).
 *
 * The instance carries the envelope payload's own enumerable properties —
 * most importantly `_tag`, which is the tag of the backend method's typed
 * failure (e.g. `"MyDomainError"`). Identity is **structural**: the
 * rejection is an `RpcError` instance re-carrying the failure's `_tag` +
 * props, not the backend's error class (which never ships to the client).
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
 * Decode a wire `{"error": ...}` payload (or a synthesized protocol
 * failure) into the value the client fails/rejects with: object payloads
 * become an {@link RpcError} carrying the payload's `_tag` + props;
 * non-object failures (e.g. `Effect.fail("boom")`) pass through verbatim.
 */
export const decodeRpcErrorPayload = (payload: unknown): unknown =>
  payload !== null && typeof payload === "object"
    ? new RpcError(payload)
    : payload;

/**
 * The backend method died with a defect. The wire envelope is sanitized
 * server-side (`{"defect": {"message"}}` — no stacks or internals), so
 * this error carries only the sanitized message.
 */
export class RpcDefectError extends Data.TaggedError("RpcDefectError")<{
  method: string;
  message: string;
}> {}

/**
 * The HTTP transport failed: the request could not be sent, or the
 * response was not a recognizable RPC envelope (e.g. an HTML 404 because
 * the URL points at something that is not an effectful Website).
 */
export class RpcTransportError extends Data.TaggedError("RpcTransportError")<{
  method: string;
  message: string;
  cause?: unknown;
}> {}

/**
 * The type-only client form (`createClient<typeof Backend>()`) was called
 * outside a browser world with no `options.url` — there is nothing to
 * POST to. On the server pass the Backend class for direct in-process
 * dispatch (`createClient(Backend)`), or provide `options.url`.
 */
export class RpcMissingUrlError extends Data.TaggedError("RpcMissingUrlError")<{
  message: string;
}> {}

/**
 * A backend method was called during prerender (a build-time world whose
 * resolved environment carries no `ALCHEMY_STACK_NAME` marker). Make the
 * page dynamic or move the call client-side.
 */
export class RpcPrerenderError extends Data.TaggedError("RpcPrerenderError")<{
  method: string;
  message: string;
}> {}

/**
 * Everything the client itself can add to a method's failure channel (the
 * backend method's own typed failures ride alongside, decoded
 * structurally — see {@link RpcError}).
 */
export type RpcClientError =
  | RpcError
  | RpcDefectError
  | RpcTransportError
  | RpcMissingUrlError
  | RpcPrerenderError;
