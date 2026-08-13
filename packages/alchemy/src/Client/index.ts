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
 * Create a typed client for an effectful Website backend — the
 * frontend→backend bridge of effectful Websites (`alchemy/client`).
 *
 * The RPC methods of the backend's impl shape (every own function-valued
 * key except `fetch` and the platform handlers `queue`, `scheduled`,
 * `email`, `tail`, ...) are the site's API surface, dispatched at the
 * reserved wire path `POST /api/__rpc/<method>` on the site's own origin
 * — no route wiring, no `server.routes` claim. `createClient` has one
 * form per world:
 *
 * - **Type-only form** — browser / client-component code:
 *   `createClient<typeof Backend>()` with a **type-only** import of the
 *   backend. Methods POST to the wire path at
 *   `options.url ?? location.origin`; zero backend bytes reach the
 *   client bundle.
 * - **Value form** — SSR / server code: `createClient(Backend)` with a
 *   value import. Methods dispatch **directly in-process** (no HTTP),
 *   with `HttpServerRequest` synthesized from `options.headers`.
 *
 * Never value-import the backend module from client-bundled code — a
 * value import pulls the backend program (and everything it touches)
 * into the browser bundle. Components use `import type` + the type-only
 * form; the value form belongs in SSR seams only (loaders, Astro
 * frontmatter, server components, `+page.server.ts` `load`).
 *
 * @binding
 * @product Client
 *
 * @section The backend's methods are the API
 * Any function-valued key on the impl shape beside `fetch` is an RPC
 * method. Methods return `Effect` (or a plain value/Promise); arguments
 * and results cross the wire as plain JSON.
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
 * @section Browser: the type-only form
 * In client-bundled code, import the backend **as a type only** and call
 * `createClient<typeof Backend>()`. Every method call POSTs to
 * `/api/__rpc/<method>` on the page's own origin — same-origin fetches,
 * so session cookies ride along by default.
 *
 * @example A client component
 * ```typescript
 * import { createClient } from "alchemy/client";
 * import type Backend from "../src/backend.ts";
 *
 * const backend = createClient<typeof Backend>();
 *
 * await backend.save("hello");        // POST /api/__rpc/save  ["hello"]
 * const value = await backend.get();  // POST /api/__rpc/get   []
 * ```
 *
 * @section Server: the value form
 * In SSR seams, import the backend **as a value** and pass the class:
 * calls dispatch straight into the backend's effects in-process — no
 * HTTP round-trip, even though the code reads identically. Pass the
 * incoming request's headers so methods that self-authorize (by reading
 * `HttpServerRequest` cookies/headers) see the caller's identity.
 *
 * @example An SSR loader
 * ```typescript
 * import { createClient } from "alchemy/client";
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
 * import { createClient } from "alchemy/client";
 * import Backend from "../src/backend.ts";
 *
 * export const backend = createClient(Backend, {
 *   headers: getRequestHeaders, // resolved per call, never captured
 * });
 * ```
 *
 * @section Typed failures and the error envelope
 * A method's typed failure crosses the wire as a 400
 * `{"error": {"_tag", ...props}}` envelope and rejects as an
 * `RpcError` **structurally** re-carrying the failure's `_tag` +
 * props (the backend's error class never ships to the client). Defects
 * are sanitized server-side to `{"defect": {"message"}}` (500, no
 * stacks) and reject as `RpcDefectError`; transport problems
 * reject as `RpcTransportError`. On the in-process path the
 * rejection is the REAL failure instance — same `_tag` discipline,
 * so code that switches on `_tag` works in both worlds.
 *
 * @example Handling a typed failure
 * ```typescript
 * import { createClient, RpcError } from "alchemy/client";
 * import type Backend from "../src/backend.ts";
 *
 * const backend = createClient<typeof Backend>();
 *
 * try {
 *   await backend.save("hello");
 * } catch (error) {
 *   if (error instanceof RpcError && error._tag === "KVError") {
 *     // the decoded envelope: _tag + the failure's own props
 *   }
 * }
 * ```
 *
 * @section Effect mode
 * `createEffectClient` is the same bridge with methods returning
 * `Effect`: the failure channel carries the method's typed failure
 * (decoded structurally on the wire path) alongside the client's own
 * `RpcClientError`s — so `Effect.catchTag` works on backend failure
 * tags.
 *
 * @example Effect-mode client
 * ```typescript
 * import { createEffectClient } from "alchemy/client";
 * import type Backend from "../src/backend.ts";
 * import * as Effect from "effect/Effect";
 *
 * const backend = createEffectClient<typeof Backend>();
 *
 * const value = yield* backend.get().pipe(
 *   Effect.catchTag("KVError", () => Effect.succeed(null)),
 * );
 * ```
 *
 * @section Prerendering
 * A prerendered (build-time) world has no deployed backend: the value
 * form fails with the typed `RpcPrerenderError` instead of
 * dispatching. Keep prerendered/static pages backend-free — make the
 * page dynamic, or move the call into client code where it becomes a
 * wire call against the deployed site.
 */
export const createClient = makeCreateClient(serverDispatch);

/**
 * The Effect-mode variant of {@link createClient}: methods return
 * `Effect` whose failure channel carries the decoded envelope (the
 * method's typed failure, structurally) alongside the client's own
 * {@link RpcClientError}s. Same two forms, same worlds, same options —
 * see {@link createClient}.
 */
export const createEffectClient = makeCreateEffectClient(serverDispatch);
