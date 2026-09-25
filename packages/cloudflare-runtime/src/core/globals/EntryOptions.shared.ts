/**
 * Direct service binding from the entry middleware to the raw user worker
 * (`SERVICE_USER_WORKER`), bypassing any downstream fetch middlewares
 * (`images:delivery`, `stream:router`, ...).
 *
 * The entry's `USER_WORKER` upstream binding points at the *next middleware
 * in the chain*, and middlewares are fetch-only HTTP-path interceptors — a
 * JSRPC call like `.email(...)` against one fails with "The RPC receiver
 * does not implement the method". Non-fetch event dispatch (`queue()`,
 * `scheduled()`, `email()`) therefore goes through this direct binding,
 * mirroring Miniflare's RPCProxyWorker model where only `fetch` traverses
 * the router chain and every other RPC method forwards straight to the user
 * worker (`workers-sdk/packages/miniflare/src/workers/assets/rpc-proxy.worker.ts`).
 */
export const BINDING_USER_WORKER_DIRECT = "USER_WORKER_DIRECT";

/**
 * Local Explorer UI + REST API (Miniflare's `/cdn-cgi/explorer`), routed by
 * the entry middleware when the worker enables `explorer`.
 */
export const PATH_EXPLORER = "/cdn-cgi/explorer";
export const BINDING_EXPLORER = "EXPLORER";
/**
 * The explorer's workerd service name. Miniflare's explorer aggregates
 * resources across dev processes by dialing each peer's `core:entry`
 * entrypoint over the workerd debug port, so the service must carry exactly
 * this name for other local workers' explorers to reach this one.
 */
export const SERVICE_EXPLORER = "core:entry";

/** Internal module-runner connection; routed directly to the Worker in dev. */
export const PATH_MODULE_RUNNER_INIT = "/cdn-cgi/alchemy/module-runner/init";
