/**
 * Environment resolution for the `alchemy/Serve` runtime bridge.
 *
 * The bridge runs inside whatever process the framework put it in — workerd
 * (Cloudflare), a Lambda sandbox, a Node dev server, or a build-time
 * prerenderer — so the deploy-time binding environment is discovered through
 * a ladder of sources rather than a single platform API:
 *
 *   1. an explicit `env` handed over by the framework (kit
 *      `event.platform.env`, nitro `event.context.cloudflare.env`)
 *   2. the guarded `cloudflare:workers` importable env (workerd)
 *   3. the `getCloudflareContext()`-shaped global OpenNext maintains
 *   4. `process.env` (Lambda / Node dev servers)
 *
 * No rung is allowed to be statically resolvable by a foreign bundler: the
 * `cloudflare:workers` import uses a non-literal specifier (the same trick
 * as `frontend-frameworks/waku/adapter.ts`) so webpack/vite/rolldown leave
 * it as a runtime `import()` that simply rejects outside workerd.
 *
 * This module has no observable side effects beyond starting that guarded
 * import — it never touches `__ALCHEMY_RUNTIME__` — so it is safe to import
 * from plan-time code and tests.
 */

/** Defeats static resolution of the specifier by foreign bundlers. */
const DO_NOT_BUNDLE = "";

let workersEnvSnapshot: Record<string, unknown> | undefined;

// Start the import at module evaluation (legal since workerd's 2025-03
// importable-env change) so env resolution on the first request only ever
// sees an already-settled promise. Outside workerd the import rejects and
// the ladder falls through; the handler is attached immediately so the
// rejection is always handled.
const cloudflareWorkersEnv: Promise<Record<string, unknown> | undefined> =
  import(
    /* @vite-ignore */ /* webpackIgnore: true */
    DO_NOT_BUNDLE + "cloudflare:workers"
  ).then(
    (mod) =>
      (workersEnvSnapshot = (mod as { env?: Record<string, unknown> }).env),
    () => undefined,
  );

/**
 * Synchronous view of the workerd env once the guarded import has settled
 * (it always has by the time the first event is dispatched). `{}` outside
 * workerd. Used by `alchemy/Serve/Worker` to derive the stack identity for
 * bridge classes that must be constructed synchronously at module scope.
 */
export const workersEnvOrEmpty = (): Record<string, unknown> =>
  workersEnvSnapshot ?? {};

export const envString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const isNonEmptyRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value as object).length > 0;

/**
 * The symbol OpenNext's `getCloudflareContext()` stores its `{ env, ctx, cf }`
 * context under — the only handle Next.js app code has to the workerd env.
 */
export const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");

const cloudflareContextEnv = (): Record<string, unknown> | undefined => {
  const context = (globalThis as Record<PropertyKey, any>)[
    cloudflareContextSymbol
  ];
  return isNonEmptyRecord(context?.env) ? context.env : undefined;
};

/**
 * Resolve the runtime environment through the ladder documented above.
 * Returns `undefined` when no rung yields anything usable.
 */
export const resolveServeEnv = async (
  explicit?: unknown,
): Promise<Record<string, unknown> | undefined> => {
  if (explicit !== undefined && explicit !== null) {
    return explicit as Record<string, unknown>;
  }
  const workersEnv = await cloudflareWorkersEnv;
  if (isNonEmptyRecord(workersEnv)) {
    return workersEnv;
  }
  const contextEnv = cloudflareContextEnv();
  if (contextEnv !== undefined) {
    return contextEnv;
  }
  if (typeof process !== "undefined" && isNonEmptyRecord(process.env)) {
    return process.env as Record<string, unknown>;
  }
  return undefined;
};

/**
 * The four-worlds guard (DESIGN §5.3): a resolved env that lacks the
 * `ALCHEMY_STACK_NAME` marker is a build-time prerender/SSG world (or a
 * deployment that never went through alchemy) — the bridge must decline
 * requests instead of building layers against a non-existent stack.
 */
export const hasStackMarkers = (
  env: Record<string, unknown> | undefined,
): env is Record<string, unknown> =>
  env !== undefined && envString(env.ALCHEMY_STACK_NAME) !== undefined;
