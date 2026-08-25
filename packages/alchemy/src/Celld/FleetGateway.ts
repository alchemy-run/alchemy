/**
 * The HTTP RPC gateway bundled into every Celld fleet Worker.
 *
 * A fleet's cells are addressed from outside the fleet (Lambda Functions,
 * ECS tasks, …) over plain HTTP — celld nodes serve the deployed Worker's
 * `fetch` handler, and this gateway is wrapped around it (see the Celld
 * worker's runtime context) so every fleet exposes the same routes:
 *
 * - `POST /{doLogicalId}/{instanceName}/__rpc__/{method}` — invoke an RPC
 *   method on the named instance (the {@link serveRpc} wire protocol:
 *   JSON args in, JSON value / error envelope / NDJSON stream out).
 * - `ANY /{doLogicalId}/{instanceName}/{...path}` — forward the request to
 *   the instance's `fetch` handler.
 * - `POST /__rpc__/{method}` — invoke an RPC method on the worker's own
 *   impl shape (the schemaless surface `Celld.bindWorker` stubs call).
 * - `GET /__alchemy__/deployment` — readiness probe returning the deployment
 *   id baked into the fleet's vars, so callers can wait for a *specific*
 *   deployment to be live on the node they reached.
 *
 * **Auth guard**: any request whose path contains {@link RPC_PATH_PREFIX}
 * requires the fleet secret in the {@link FLEET_SECRET_HEADER} header
 * (constant-time compared); a missing and a wrong secret answer with an
 * identical 401. Every other path — the user's own `fetch` surface, plain
 * HTTP forwarding to an instance, the readiness probe — passes through
 * unauthenticated; that surface belongs to the user.
 *
 * This module is bundled into the fleet Worker: keep it free of node-only
 * APIs (celld implements the workers runtime, not node).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerRequests from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpEffect } from "../Http.ts";
import { RPC_PATH_PREFIX, serveRpc } from "../Rpc.ts";
import { makeRpcStub } from "../Cloudflare/Workers/Rpc.ts";
import { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";

/** The wrangler `vars` key carrying the fleet auth secret. */
export const FLEET_SECRET_VAR = "ALCHEMY_FLEET_SECRET";
/** The request header carrying the fleet auth secret. */
export const FLEET_SECRET_HEADER = "x-alchemy-fleet-secret";
/** The wrangler `vars` key carrying the deployment id (the code hash). */
export const FLEET_DEPLOYMENT_VAR = "ALCHEMY_FLEET_DEPLOYMENT";
/** The readiness-probe route. */
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

const notFound = HttpServerResponse.text("Not Found", { status: 404 });
// ONE unauthorized response for every failure mode (missing header, wrong
// secret) — identical status and body, so a prober learns nothing about
// which check failed.
const unauthorized = HttpServerResponse.text("Unauthorized", { status: 401 });

/**
 * Wrap the fleet's (optional) user `fetch` handler with the gateway routes.
 * See the module doc for the route table and the auth-guard rule.
 */
export const makeGatewayFetch = (
  userFetch?: HttpEffect<any> | Effect.Effect<HttpEffect<any>, any, any>,
  options?: {
    /**
     * The worker impl's full shape — its non-handler methods are served as
     * worker-level RPC methods under `POST /__rpc__/{method}`.
     */
    readonly shape?: Record<string, unknown>;
  },
): HttpEffect<any> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    // `request.url` is a full URL under the workers runtime and a bare path
    // under other adapters — normalize against a dummy base.
    const url = new URL(request.url, "http://fleet");
    const env = yield* Effect.serviceOption(WorkerEnvironment).pipe(
      Effect.map(Option.getOrUndefined),
    );

    const delegate: HttpEffect<any> = Effect.gen(function* () {
      if (userFetch === undefined) {
        return notFound;
      }
      // `userFetch` may be the `HttpEffect` itself or an Effect resolving
      // to one (the `Main.fetch` shape) — same normalization as
      // `safeHttpEffect`.
      const response = yield* userFetch as Effect.Effect<any, any, any>;
      return HttpServerResponse.isHttpServerResponse(response)
        ? response
        : yield* response as HttpEffect<any>;
    }) as HttpEffect<any>;

    // The auth guard covers exactly the RPC surface: any path containing
    // the RPC prefix (worker-level `/__rpc__/{m}` and Durable Object
    // `/{ns}/{name}/__rpc__/{m}` alike). Everything else falls through to
    // the user's public surface untouched.
    if (url.pathname.includes(RPC_PATH_PREFIX)) {
      const secret = env?.[FLEET_SECRET_VAR];
      const provided = request.headers[FLEET_SECRET_HEADER];
      if (
        typeof secret !== "string" ||
        typeof provided !== "string" ||
        !timingSafeStringEqual(secret, provided)
      ) {
        return unauthorized;
      }
    }

    if (url.pathname === FLEET_DEPLOYMENT_PATH) {
      return yield* HttpServerResponse.json({
        deploymentId: env?.[FLEET_DEPLOYMENT_VAR],
      });
    }

    // `/{doLogicalId}/{instanceName}/...` — route to a Durable Object
    // namespace when (and only when) the first segment names one; anything
    // else belongs to the worker's own surface.
    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length >= 2) {
      const namespace = env?.[decodeURIComponent(segments[0])];
      if (namespace && typeof namespace.getByName === "function") {
        const instanceName = decodeURIComponent(segments[1]);
        const stub = makeRpcStub<Record<string, unknown>>(
          namespace.getByName(instanceName),
        );
        // Forward to the instance's `fetch` with the `/{do}/{name}` prefix
        // stripped. This includes `/__rpc__/{method}` calls — the Durable
        // Object bridge serves the RPC protocol on its own fetch (streaming
        // results ride HTTP chunked bodies; celld's JSRPC cannot transfer
        // ReadableStreams across the cell boundary).
        const web = yield* HttpServerRequests.toWeb(request);
        const rest = `/${segments.slice(2).join("/")}${url.search}`;
        const target = new globalThis.Request(new URL(rest, web.url), web);
        return yield* (
          stub as unknown as {
            fetch: (
              request: HttpServerRequest,
            ) => Effect.Effect<HttpServerResponse.HttpServerResponse, any>;
          }
        ).fetch(HttpServerRequests.fromWeb(target));
      }
    }

    // Worker-level RPC (`/__rpc__/{method}` with no Durable Object
    // segment): dispatch to the impl shape's methods; every other path
    // delegates to the user's fetch handler.
    return yield* serveRpc(options?.shape ?? {}, delegate);
  }) as HttpEffect<any>;
