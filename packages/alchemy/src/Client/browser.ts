/**
 * The `"browser"`-condition build of `alchemy/Client` — a guidance stub.
 *
 * Schema-less RPC is for TRUSTED callers only: `createClient(Backend)` is
 * the server/SSR in-process dispatch and has no browser transport. In
 * client-bundled code the calls below throw with actionable guidance —
 * the browser talks to the backend through a schema the user owns (effect
 * `HttpApi` / `@effect/rpc`) mounted on the backend's `fetch` handler.
 *
 * This module carries zero server bytes (its `Core.ts`/`Errors.ts`
 * imports are type-only and erased).
 */

import type { CreateClient, CreateEffectClient } from "./Core.ts";

export type {
  AnyBackendClass,
  ClientOptions,
  ClientShape,
  CreateClient,
  CreateEffectClient,
  RpcClient,
  RpcEffectClient,
  RpcFailure,
  RpcMethodShape,
  RpcSuccess,
  ServerClientOptions,
} from "./Core.ts";
export type { RpcClientError, RpcError, RpcPrerenderError } from "./Errors.ts";

const browserGuidance = (): Error =>
  new Error(
    "createClient is server-only — the browser talks to your backend " +
      "through a schema you own: define an effect HttpApi (or @effect/rpc) " +
      "schema, mount it on the fetch handler, and build the client from " +
      "the schema import. Schema-less RPC is reserved for trusted callers " +
      "(SSR/server code and service bindings).",
  );

/** Browser build: throws — see the module doc for the schema guidance. */
export const createClient: CreateClient = (() => {
  throw browserGuidance();
}) as unknown as CreateClient;

/** Browser build: throws — see the module doc for the schema guidance. */
export const createEffectClient: CreateEffectClient = (() => {
  throw browserGuidance();
}) as unknown as CreateEffectClient;
