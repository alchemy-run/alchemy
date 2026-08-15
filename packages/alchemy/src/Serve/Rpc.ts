/**
 * Trusted-caller RPC helpers of the serve core: the shape-method
 * resolution and typed-failure encoding shared by the schema-less RPC
 * transports that only trusted callers reach — the value-form
 * `createClient` (`alchemy/Client`'s direct in-process dispatch on the
 * server) and the Cloudflare WorkerEntrypoint JS-RPC bridge
 * (`worker.method(...)` over service bindings). Schema-less RPC has no
 * public HTTP wire: untrusted browser clients go through schema-validated
 * surfaces (effect `HttpApi` / `@effect/rpc`) the user mounts on their
 * own fetch handler.
 *
 * Methods are the **own enumerable function-valued keys** of the impl
 * shape; `fetch` and the platform handler keys (`queue`, `scheduled`,
 * `email`, `tail`, ...) are never dispatchable.
 *
 * This module is a serve-core LEAF (like `Routes.ts`): it must never
 * import `Worker.ts`/provider graphs — it is compiled into foreign server
 * bundles (Next/turbopack, nitro rollup) and evaluated at plan time by
 * the engine.
 */

/**
 * Platform handler keys that are never dispatchable as RPC methods (the
 * Cloudflare `ExportedHandler` set — kept as a literal so this leaf never
 * imports `Worker.ts`).
 */
const PLATFORM_HANDLER_KEYS: ReadonlySet<string> = new Set([
  "fetch",
  "tail",
  "trace",
  "tailStream",
  "scheduled",
  "test",
  "email",
  "queue",
]);

/**
 * Resolve the RPC-dispatchable methods of an impl shape: own enumerable
 * function-valued keys, minus `fetch` and the platform handler keys.
 */
export const rpcMethodsOf = (
  shape: Record<string, unknown> | undefined,
): Record<string, (...args: unknown[]) => unknown> => {
  const methods: Record<string, (...args: unknown[]) => unknown> = {};
  if (shape === undefined || shape === null) {
    return methods;
  }
  for (const key of Object.keys(shape)) {
    const value = shape[key];
    if (typeof value === "function" && !PLATFORM_HANDLER_KEYS.has(key)) {
      methods[key] = value as (...args: unknown[]) => unknown;
    }
  }
  return methods;
};

/**
 * Normalize a typed failure into a plain, serialization-safe payload (the
 * `error` half of a failure envelope): tagged errors keep `_tag` + own
 * enumerable props (plus `message` when the error is an `Error` whose
 * message isn't an own prop); plain `Error`s keep `name`/`message`;
 * everything else passes through.
 */
export const encodeRpcFailure = (error: unknown): unknown => {
  if (error === null || error === undefined || typeof error !== "object") {
    return error;
  }
  const obj = error as Record<string, unknown>;
  if (typeof obj._tag === "string") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      out[key] = obj[key];
    }
    if (error instanceof Error && !("message" in out)) {
      out.message = error.message;
    }
    return out;
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return error;
};
