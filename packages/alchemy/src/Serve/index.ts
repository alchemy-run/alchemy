/**
 * `alchemy/Serve` — the runtime bridge that mounts an effectful Website's
 * handlers inside a framework-built server bundle. See `Serve.ts` for the
 * surface and `Bridge.ts` for the runtime core.
 *
 * Importing this module has no plan-observable side effects (in particular
 * it does NOT set `__ALCHEMY_RUNTIME__` — that is stamped when a bridge is
 * constructed), so `src/backend.ts` may import from `alchemy/Serve` and still be
 * evaluated by the engine at plan time.
 */
export * from "./Serve.ts";
export * as Serve from "./Serve.ts";
