/**
 * The celld entrypoint: the workerd worker bridge PLUS the fleet gateway.
 *
 * A fleet runs the same Effect worker bundle Cloudflare Workers do, so the
 * event dispatch IS `makeWorkerBridge` (workerd's `WorkerEntrypoint`
 * bridge over the engine-invariant core). celld's loader requires the
 * main worker in the **object form** (`export default { fetch }`), so the
 * bridge class is instantiated per event — the isolate build inside it is
 * module-memoized, so that costs a closure, not a rebuild.
 *
 * In front of the user's worker sits the **gateway**, the route table
 * every fleet exposes to callers on the fleet network:
 *
 * - `POST /{doLogicalId}/{instanceName}/__rpc__/{method}` — invoke an RPC
 *   method on the named cell (the fetch-RPC wire protocol).
 * - `ANY /{doLogicalId}/{instanceName}/{...path}` — forward the request to
 *   the cell's `fetch` handler.
 * - `POST /__rpc__/{method}` — invoke an RPC method on the worker's own
 *   impl shape (the schemaless surface `Celld.bindWorker` stubs call).
 * - `GET /__alchemy__/deployment` — readiness probe answering the
 *   deployment id baked into the fleet's vars.
 *
 * **Auth guard**: a request whose *pathname* addresses an RPC method (see
 * `rpcMethodOf` — a query string or fragment containing the prefix is not
 * a dispatch) requires the per-worker gateway secret in the
 * {@link FLEET_SECRET_HEADER} header, constant-time compared; a missing
 * and a wrong secret answer with an identical 401. Every other path — the
 * user's own `fetch` surface, plain HTTP forwarding to a cell, the
 * readiness probe — passes through unauthenticated.
 *
 * Bundled into the fleet worker: keep it free of node-only APIs.
 */
import type { WorkerEntrypoint } from "cloudflare:workers";
import { makeWorkerBridge } from "../Cloudflare/Workers/WorkerBridge.ts";
import { rpcMethodOf } from "../Rpc.ts";

/** The wrangler `vars` key carrying the per-worker gateway secret. */
export const FLEET_SECRET_VAR = "ALCHEMY_FLEET_SECRET";
/** The request header carrying the gateway secret. */
export const FLEET_SECRET_HEADER = "x-alchemy-fleet-secret";
/** The wrangler `vars` key carrying the deployment id (the code hash). */
export const FLEET_DEPLOYMENT_VAR = "ALCHEMY_FLEET_DEPLOYMENT";
/** The readiness-probe route (also the ingress health check). */
export const FLEET_DEPLOYMENT_PATH = "/__alchemy__/deployment";

/**
 * Constant-time string equality over UTF-8 bytes. `crypto.timingSafeEqual`
 * is node-only, so fold XOR differences across the longer of the two byte
 * arrays instead — the loop length depends only on the inputs' lengths, not
 * on where they first differ.
 */
export const timingSafeStringEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const length = Math.max(ab.length, bb.length);
  for (let i = 0; i < length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
};

/** A native namespace binding, as found under the class name in `env`. */
interface NamespaceBinding {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

const isNamespaceBinding = (value: unknown): value is NamespaceBinding =>
  typeof value === "object" &&
  value !== null &&
  "getByName" in value &&
  typeof value.getByName === "function";

/**
 * The object-form main worker celld's loader requires: the gateway route
 * table in front of the workerd worker bridge.
 */
export const makeCelldWorkerBridge = (
  WorkerEntrypointClass: typeof WorkerEntrypoint,
  entrypoint: unknown,
  options: {
    readonly stack: { readonly name: string; readonly stage: string };
  },
) => {
  const WorkerBridge = makeWorkerBridge(WorkerEntrypointClass, {
    entrypoint,
    stack: { name: options.stack.name, stage: options.stack.stage },
  });

  return {
    fetch: (
      request: Request,
      env: Record<string, unknown>,
      ctx: unknown,
    ): Promise<Response> | Response => {
      const url = new URL(request.url);

      // The guard covers exactly the RPC surface: worker-level
      // `/__rpc__/{m}` and cell-level `/{ns}/{name}/__rpc__/{m}` alike.
      if (rpcMethodOf(request) !== undefined) {
        const secret = env[FLEET_SECRET_VAR];
        const provided = request.headers.get(FLEET_SECRET_HEADER);
        if (
          typeof secret !== "string" ||
          provided === null ||
          !timingSafeStringEqual(secret, provided)
        ) {
          // ONE unauthorized response for every failure mode — identical
          // status and body, so a prober learns nothing about which check
          // failed.
          return new Response("Unauthorized", { status: 401 });
        }
      }

      if (url.pathname === FLEET_DEPLOYMENT_PATH) {
        return new Response(
          JSON.stringify({ deploymentId: env[FLEET_DEPLOYMENT_VAR] }),
          { headers: { "content-type": "application/json" } },
        );
      }

      // `/{doLogicalId}/{instanceName}/...` — route to a Durable Object
      // namespace when (and only when) the first segment names one;
      // anything else belongs to the worker's own surface. The cell's
      // bridge serves the RPC protocol on its own `fetch` (streaming
      // results ride HTTP chunked bodies; celld's JSRPC cannot transfer
      // ReadableStreams across the cell boundary), so `/__rpc__/{method}`
      // forwards like any other path.
      const [head, name, ...rest] = url.pathname
        .split("/")
        .filter((segment) => segment.length > 0);
      if (head !== undefined && name !== undefined) {
        const namespace = env[decodeURIComponent(head)];
        if (isNamespaceBinding(namespace)) {
          const target = new URL(`/${rest.join("/")}${url.search}`, url);
          return namespace
            .getByName(decodeURIComponent(name))
            .fetch(new Request(target, request));
        }
      }

      // The worker's own surface: its `fetch` handler, with worker-level
      // RPC served under `/__rpc__/{method}` by the runtime context. The
      // bridge installs `fetch` per instance (its base is workerd's
      // `WorkerEntrypoint`, where the handler is optional).
      const bridge = new WorkerBridge(ctx, env) as unknown as {
        fetch: (request: Request) => Promise<Response>;
      };
      return bridge.fetch(request);
    },
  };
};
