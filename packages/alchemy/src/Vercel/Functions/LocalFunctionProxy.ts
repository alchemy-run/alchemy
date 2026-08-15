/**
 * The stable-URL proxy in front of a locally running Vercel Function
 * (the `WorkerProxy` pattern, Effect-native):
 *
 * - The proxy owns the Function's public `http://localhost:<port>` URL and
 *   lives OUTSIDE the provider's per-instance scope, so the URL survives
 *   rebuilds, config restarts, and even instance replacement — it is torn
 *   down only by the provider's `stop` (delete).
 * - Rebuilds are make-before-break: the previous child keeps serving until
 *   the replacement is ready, then {@link LocalFunctionProxyInstance.set}
 *   cuts over atomically.
 * - Requests arriving before the FIRST child is ready are held until the
 *   upstream appears (bounded), so `deploy` + immediate `fetch` works.
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { httpServer } from "../../Util/PlatformServices.ts";

export interface LocalFunctionProxyInstance {
  /** Stable public origin, e.g. `http://localhost:53123` (no trailing slash). */
  readonly url: string;
  /** Cut requests over to a new upstream origin (make-before-break). */
  readonly set: (upstream: string) => Effect.Effect<void>;
}

/** How long early requests wait for the first upstream before a 503. */
const FIRST_UPSTREAM_TIMEOUT = "120 seconds";

/**
 * Serve a proxy in the ambient `Scope`. `port` is a preference: when taken,
 * the proxy logs a warning and falls back to an ephemeral port.
 */
export const serveFunctionProxy = Effect.fn(function* (options: {
  readonly port?: number | undefined;
}) {
  const client = yield* HttpClient.HttpClient;
  const upstream = yield* Ref.make<string | undefined>(undefined);
  const everSet = yield* Deferred.make<void>();

  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Hold early requests until the first child is serving.
    yield* Deferred.await(everSet).pipe(
      Effect.timeoutOrElse({
        duration: FIRST_UPSTREAM_TIMEOUT,
        orElse: () => Effect.void,
      }),
    );
    const origin = yield* Ref.get(upstream);
    if (origin === undefined) {
      return HttpServerResponse.text("local function is not ready yet", {
        status: 503,
      });
    }
    // `toClientRequest` already parsed the query string into `urlParams`,
    // so the rewritten URL carries only the path — the params re-attach at
    // execution (appending the full `request.url` would duplicate them).
    // The child sees the ORIGINAL Host header, so URLs it constructs show
    // the stable proxy address.
    let outgoing = HttpServerRequest.toClientRequest(request).pipe(
      HttpClientRequest.setUrl(`${origin}${request.url.split("?")[0]}`),
    );
    // A request that declares no body (no content-length, not chunked)
    // must forward WITHOUT a body stream: fetch with an (empty) stream
    // body fails on bodied-method requests like DELETE ("Transport
    // error") and would force chunked encoding upstream.
    const declaresBody =
      (request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0") ||
      request.headers["transfer-encoding"] !== undefined;
    if (!declaresBody) {
      outgoing = HttpClientRequest.setBody(outgoing, HttpBody.empty);
    }
    return yield* client.execute(outgoing).pipe(
      Effect.map(HttpServerResponse.fromClientResponse),
      Effect.catchCause((cause) =>
        Effect.as(
          Effect.logWarning("[alchemy dev] proxy forward failed", cause),
          HttpServerResponse.text("local function proxy error", {
            status: 502,
          }),
        ),
      ),
    );
  });

  const build = (port: number) =>
    Layer.build(httpServer(port, "127.0.0.1")) as Effect.Effect<
      Context.Context<HttpServer.HttpServer>,
      unknown,
      Scope.Scope
    >;
  const context = yield* options.port !== undefined
    ? build(options.port).pipe(
        Effect.catch((error) =>
          Effect.andThen(
            Effect.logWarning(
              `Port ${options.port} is in use by another process; serving the local function on an ephemeral port instead. Stop the other process or pick a different \`dev.port\`.`,
              error,
            ),
            build(0),
          ),
        ),
      )
    : build(0);
  const server = Context.get(context, HttpServer.HttpServer);
  yield* server.serve(handler);

  const url = HttpServer.formatAddress(server.address)
    .replace("127.0.0.1", "localhost")
    .replace(/\/$/, "");

  return {
    url,
    set: (next: string) =>
      Effect.andThen(
        Ref.set(upstream, next.replace(/\/$/, "")),
        Deferred.succeed(everSet, void 0),
      ).pipe(Effect.asVoid),
  } satisfies LocalFunctionProxyInstance;
});
