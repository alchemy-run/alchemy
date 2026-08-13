/**
 * `alchemy/client` — the frontend→backend bridge of effectful Websites.
 *
 * One export, two overloads, world-appropriate:
 *
 * ```ts
 * // BROWSER / client components: TYPE-ONLY import — zero backend bytes
 * // in the client bundle, on every bundler.
 * import { createClient } from "alchemy/client";
 * import type Backend from "../src/backend.ts";
 * const backend = createClient<typeof Backend>();
 * const n = await backend.bump();          // typed; POST /api/__rpc/bump
 *
 * // SSR / server code: VALUE import — direct in-process dispatch, no HTTP.
 * import Backend from "../src/backend.ts";
 * const backend = createClient(Backend, { headers: request.headers });
 * const n = await backend.bump();          // direct effect invocation
 * ```
 *
 * This is the default (server-capable) entry: the value form's in-process
 * dispatch lives behind a guarded dynamic import of `./Server.ts`, and
 * the `"browser"` export condition swaps this module for `browser.ts`
 * (identical surface, no server branch) so client bundles stay tiny.
 */

import {
  makeCreateClient,
  makeCreateEffectClient,
  type ServerDispatch,
} from "./Core.ts";

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
export {
  RpcDefectError,
  RpcError,
  RpcMissingUrlError,
  RpcPrerenderError,
  RpcTransportError,
  type RpcClientError,
} from "./Errors.ts";

/**
 * The guarded server branch: only ever evaluated when the VALUE form runs
 * outside a browser world, so importing `alchemy/client` never statically
 * pulls the serve-bridge graph (and the `"browser"` condition removes
 * even this dynamic edge from client bundles).
 */
const serverDispatch: ServerDispatch = async (site, method, args, options) => {
  const server = await import("./Server.ts");
  return server.invokeServerMethod(site, method, args, options);
};

/**
 * Create a typed client for an effectful Website backend (Promise mode).
 *
 * - `createClient<typeof Backend>(options?)` — type-only form for
 *   browser/client code: methods POST to the universal wire path
 *   (`/api/__rpc/<method>`) at `options.url ?? location.origin`.
 * - `createClient(Backend, options?)` — value form for server code:
 *   direct in-process dispatch (no HTTP), with `HttpServerRequest`
 *   synthesized from `options.headers`.
 */
export const createClient = makeCreateClient(serverDispatch);

/**
 * The Effect-mode variant of {@link createClient}: methods return
 * `Effect` whose failure channel carries the decoded envelope (typed
 * failure tags, structurally) alongside the client's own errors.
 */
export const createEffectClient = makeCreateEffectClient(serverDispatch);
