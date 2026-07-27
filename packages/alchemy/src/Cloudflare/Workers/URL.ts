import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import type { URLBinding } from "./URLBinding.ts";

const TypeId = "Cloudflare.Workers.URL" as const;
type TypeId = typeof TypeId;

/**
 * Effect-native accessor for the Worker's own URL. The value is injected as an
 * env binding that only exists at the *exec* phase on the deployed Worker, so
 * reading it is deferred behind an Effect that requires {@link RuntimeContext}.
 * Yield it inside a handler to obtain the URL string.
 */
export type URLAccessor = Effect.Effect<string, never, RuntimeContext>;

/**
 * The `Binding.Service` tag behind {@link URL}. Provide
 * {@link URLBinding} on the Worker effect to satisfy it; user code
 * interacts with the {@link URL} binding value instead.
 */
export interface URLService extends Binding.Service<
  URLService,
  TypeId,
  URLAccessor
> {
  (name?: string): URLBinding;
}

export const URLService = Binding.Service<URLService>({
  id: TypeId,
  defaultName: "WORKER_URL",
  toWorkerBinding: (binding) => ({
    type: "self_url",
    name: binding.name,
  }),
});

/**
 * A Worker's own public URL, injected as a binding on that same Worker — a
 * Worker-only binding with no backing cloud resource. At deploy time Alchemy
 * resolves the URL the Worker will be served at (its first custom domain if
 * any, otherwise its `workers.dev` URL) and injects it as a plain-text env
 * binding, so the running Worker knows its own public address.
 *
 * Declare it on a Worker's `env` (it flows through `InferEnv` → `string`) or
 * `yield*` it inside an Effect-native Worker to attach the binding and obtain
 * a deferred {@link URLAccessor}. It is also exposed as
 * `Cloudflare.Worker.URL`.
 *
 * Because the URL is resolved *before* the bundle is built, a `VITE_`-prefixed
 * env key holding `Worker.URL` is inlined into the client bundle as
 * `import.meta.env.VITE_*` — the canonical way to give a Vite frontend its own
 * public URL.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 * @section Effect-style Worker (recommended)
 * @example Read the Worker's own URL inside a handler
 * ```typescript
 * import * as Effect from "effect/Effect";
 *
 * Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Attaches the binding to this Worker AND returns a deferred accessor.
 *     const url = yield* Cloudflare.Worker.URL;
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const publicUrl = yield* url;
 *         return Response.json({ url: publicUrl });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.URLBinding)),
 * );
 * ```
 *
 * @section Worker binding metadata
 * @example Inject the public URL into a Vite frontend
 * ```typescript
 * export const Site = Cloudflare.Worker("Site", {
 *   vite: { rootDir: "./app" },
 *   env: {
 *     // Inlined into the client bundle as import.meta.env.VITE_PUBLIC_URL
 *     // and available as env.VITE_PUBLIC_URL on the server.
 *     VITE_PUBLIC_URL: Cloudflare.Worker.URL,
 *   },
 * });
 *
 * export type SiteEnv = Cloudflare.InferEnv<typeof Site>;
 * //   { VITE_PUBLIC_URL: string }
 * ```
 */
export const URL: URLBinding = URLService();

/**
 * Returns true when the value is a `Worker.URL` binding value. Structural
 * (keyed on `kind` alone): the engine deep-resolves props before handing them
 * to providers, which strips the binding value's methods — inside `reconcile`
 * only the plain `{ kind, name }` data survives.
 */
export const isSelfUrl = (value: unknown): value is URLBinding =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === TypeId;
