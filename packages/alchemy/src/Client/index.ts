/**
 * `alchemy/Client` — the server-side bridge into an effectful Website's
 * backend methods.
 *
 * ```ts
 * // SSR / server code: VALUE import — direct in-process dispatch, no HTTP.
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 * const backend = createClient(Backend, { headers: request.headers });
 * const n = await backend.bump();          // direct effect invocation
 * ```
 *
 * Schema-less RPC is for TRUSTED callers only — there is no public HTTP
 * wire. Untrusted browser clients talk to the backend through a schema
 * the user owns (effect `HttpApi` / `@effect/rpc`) mounted on the
 * backend's `fetch` handler. The in-process dispatch lives behind a
 * guarded dynamic import of `./Server.ts`, and the `"browser"` export
 * condition swaps this module for `browser.ts` (a guidance-throwing
 * stub) so client bundles never carry backend bytes.
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
export { RpcError, RpcPrerenderError, type RpcClientError } from "./Errors.ts";

/**
 * The guarded server branch: only ever evaluated when a method call
 * dispatches, so importing `alchemy/Client` never statically pulls the
 * serve-bridge graph (and the `"browser"` condition removes even this
 * dynamic edge from client bundles).
 */
const serverDispatch: ServerDispatch = async (site, method, args, options) => {
  const server = await import("./Server.ts");
  return server.invokeServerMethod(site, method, args, options);
};

/**
 * Create a typed server-side client for an effectful Website backend
 * (`alchemy/Client`).
 *
 * The RPC methods of the backend's impl shape (every own function-valued
 * key except `fetch` and the platform handlers `queue`, `scheduled`,
 * `email`, `tail`, ...) are the site's API surface for TRUSTED callers.
 * `createClient(Backend)` takes a **value** import of the backend class
 * and dispatches every method call **directly in-process** — no HTTP, no
 * serialization — with `HttpServerRequest` synthesized from
 * `options.headers`. It belongs in SSR seams only (loaders, Astro
 * frontmatter, server components, `+page.server.ts` `load`).
 *
 * There is no browser form: schema-less RPC never crosses a trust
 * boundary. For browser/client-component code, define a schema you own —
 * an effect `HttpApi` (or `@effect/rpc` group) — mount it on the
 * backend's `fetch` handler, and build the browser client from the
 * schema import.
 *
 * @binding
 * @product Client
 *
 * @section The backend's methods are the API
 * Any function-valued key on the impl shape beside `fetch` and the
 * platform handlers is an RPC method. Methods return `Effect` (or a
 * plain value/Promise); the value form invokes them in-process, so
 * arguments and results never serialize.
 *
 * @example src/backend.ts
 * ```typescript
 * import * as KV from "alchemy/Cloudflare/KV";
 * import * as Website from "alchemy/Cloudflare/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Users = KV.Namespace("Users");
 *
 * export default class Backend extends Website.Vite<Backend>()(
 *   "Site",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const users = yield* KV.ReadWriteNamespace(yield* Users);
 *     return {
 *       get: () => users.get("current"),
 *       save: (value: string) => users.put("current", value),
 *     };
 *   }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
 * ) {}
 * ```
 *
 * @section Server: the value form
 * In SSR seams, import the backend **as a value** and pass the class:
 * calls dispatch straight into the backend's effects in-process. Pass the
 * incoming request's headers so methods that self-authorize (by reading
 * `HttpServerRequest` cookies/headers) see the caller's identity.
 *
 * @example An SSR loader
 * ```typescript
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 *
 * export const load = async ({ request }: { request: Request }) => {
 *   const backend = createClient(Backend, { headers: request.headers });
 *   return { value: await backend.get() }; // direct dispatch — no HTTP
 * };
 * ```
 *
 * @section Per-request identity on a shared client
 * `options.headers` also accepts a **thunk**, resolved fresh on every
 * call — so a module-scope client stays per-request-correct when the
 * framework exposes an ambient request accessor (TanStack Start's
 * `getRequestHeaders`, Next's `headers`).
 *
 * @example Module-scope client with an ambient accessor
 * ```typescript
 * import { getRequestHeaders } from "@tanstack/react-start/server";
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 *
 * export const backend = createClient(Backend, {
 *   headers: getRequestHeaders, // resolved per call, never captured
 * });
 * ```
 *
 * @section Typed failures are real instances
 * A failing method rejects with its typed failure AS-IS — the real error
 * instance, so `instanceof` and `_tag` checks against your own error
 * classes both work. Calling a method the backend doesn't expose rejects
 * with an `RpcError` tagged `RpcMethodNotFound`.
 *
 * @example Handling a typed failure
 * ```typescript
 * import { createClient } from "alchemy/Client";
 * import Backend, { UserNotFound } from "../src/backend.ts";
 *
 * const backend = createClient(Backend);
 *
 * try {
 *   await backend.save("hello");
 * } catch (error) {
 *   if (error instanceof UserNotFound) {
 *     // the method's own typed failure — the real instance
 *   }
 * }
 * ```
 *
 * @section Effect mode
 * `createEffectClient` is the same bridge with methods returning
 * `Effect`: the failure channel carries the method's typed failure
 * alongside the client's own `RpcClientError`s — so `Effect.catchTag`
 * works on backend failure tags.
 *
 * @example Effect-mode client
 * ```typescript
 * import { createEffectClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 * import * as Effect from "effect/Effect";
 *
 * const backend = createEffectClient(Backend);
 *
 * const value = yield* backend.get().pipe(
 *   Effect.catchTag("KVError", () => Effect.succeed(null)),
 * );
 * ```
 *
 * @section Browser clients bring their own schema
 * Untrusted callers never get schema-less dispatch. Define an effect
 * `HttpApi` (or `@effect/rpc`) schema, serve it from the backend's
 * `fetch` handler, and derive the browser client from the schema import
 * — the schema module is plain types + Schema values, safe to bundle.
 *
 * @example Mounting an HttpApi on the fetch handler
 * ```typescript
 * import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
 * import { api } from "./api.ts"; // your HttpApi schema — browser-safe
 *
 * // inside the backend's impl shape:
 * return {
 *   fetch: HttpApiBuilder.toWebHandler(apiLayers),
 * };
 * ```
 *
 * @section Prerendering
 * A prerendered (build-time) world has no deployed backend: the value
 * form fails with the typed `RpcPrerenderError` instead of dispatching.
 * Keep prerendered/static pages backend-free — make the page dynamic, or
 * fetch through your schema'd API at runtime instead.
 */
export const createClient = makeCreateClient(serverDispatch);

/**
 * The Effect-mode variant of {@link createClient}: methods return
 * `Effect` whose failure channel carries the method's REAL typed failure
 * alongside the client's own {@link RpcClientError}s. Same form, same
 * options — see {@link createClient}.
 */
export const createEffectClient = makeCreateEffectClient(serverDispatch);
