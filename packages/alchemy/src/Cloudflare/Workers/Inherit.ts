import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import * as Binding from "./Binding.ts";
import type { InheritBinding } from "./InheritBinding.ts";

const TypeId = "Cloudflare.Workers.Inherit" as const;
type TypeId = typeof TypeId;

/**
 * Effect-native accessor for an inherited binding. The env value only exists
 * at the *exec* phase on the deployed Worker, so reading it is deferred behind
 * an Effect that requires {@link RuntimeContext}.
 *
 * Cloudflare copies the previous upload's binding of this name. Alchemy never
 * reads the inherited value. The runtime type is `unknown` because inherit
 * can resolve to a secret, plaintext, or (if you inherit a resource name)
 * whatever that binding was.
 */
export type InheritAccessor = Effect.Effect<unknown, never, RuntimeContext>;

/**
 * Inherit a named binding from the Worker's previous upload without supplying
 * or reading its value.
 *
 * Cloudflare's upload API accepts only the literal `"latest"` as the inherit
 * source — that is the latest *uploaded* version, not necessarily the version
 * serving 100% of traffic. Alchemy always sends `version_id: "latest"` and
 * `bindings_inherit=strict`, so a missing name fails the upload instead of
 * being silently dropped.
 *
 * An undeployed preview (`version.traffic: 0` / `wrangler versions upload`)
 * becomes `"latest"`. If that preview omitted or changed the named binding,
 * the next inherit deploy follows the preview, not the live 100% version.
 *
 * `Inherit` is a Worker-only binding with no backing cloud resource. Declare
 * it on a Worker's `env` or `yield*` it inside an Effect-native Worker.
 *
 * Not supported in `alchemy dev` — workerd cannot inherit from a Cloudflare
 * version history. Local start fails closed.
 *
 * @binding
 * @product Workers
 * @category Workers & Compute
 *
 * @section Preserve a secret on a code-only deploy
 * @example Async Worker
 * ```typescript
 * export const Api = Cloudflare.Worker("Api", {
 *   main: "./src/api.ts",
 *   env: {
 *     API_TOKEN: Cloudflare.Workers.Inherit(),
 *   },
 * });
 * ```
 *
 * @example Effect-native Worker
 * ```typescript
 * Cloudflare.Worker(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const apiToken = yield* Cloudflare.Workers.Inherit("API_TOKEN");
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const token = yield* apiToken;
 *         return new Response(token == null ? "missing" : "ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workers.InheritBinding)),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/#inherit
 */
export interface Inherit extends Binding.Service<
  Inherit,
  TypeId,
  InheritAccessor
> {
  /**
   * @param name Binding name (logical id) — the `env` key it resolves to.
   *   When declared as `env: { API_TOKEN: Inherit() }`, the env key is used.
   */
  (name?: string): InheritBinding;
}

export const Inherit = Binding.Service<Inherit>({
  id: TypeId,
  defaultName: "INHERIT",
  toWorkerBinding: (binding) => ({
    type: "inherit",
    name: binding.name,
    versionId: "latest",
  }),
});

/** Call-site alias for {@link Inherit}. */
export const inherit = Inherit;

export const isInherit = (value: unknown): value is InheritBinding =>
  Binding.isBinding(value) && value.kind === TypeId;

/**
 * Cloudflare inherit bindings accept only `version_id: "latest"` (error
 * 10057). Without `bindings_inherit=strict`, an unresolvable inherit is
 * silently dropped. Send strict exactly when the upload carries inherit
 * markers.
 */
export const bindingsInheritFor = (
  bindings: readonly { readonly type?: string }[] | undefined,
): "strict" | undefined =>
  bindings?.some((binding) => binding.type === "inherit")
    ? "strict"
    : undefined;
