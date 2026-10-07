import * as NodeHttp from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream";
import type { URL as NodeURL } from "node:url";
import type * as vite from "vite";
import { HOP_BY_HOP_HEADERS, proxyRequestHeaders } from "./forwarded-host.ts";

/**
 * Forwards a dev or preview server request to the Worker runtime at `target`
 * and relays the Worker's response.
 *
 * Every request gets a connection of its own. A pooled connection races
 * workerd, which closes one after 5s idle (as long as Node's global agent keeps
 * it) without sending a `Keep-Alive` hint, and also closes one whose streamed
 * response it cut short. A request sent on such a connection fails with
 * `socket hang up` and answers 502. workerd runs on the same host, so a fresh
 * connection costs next to nothing; the client's connection to the Vite
 * server stays kept alive.
 *
 * When the client hangs up, the Worker request is cancelled, as it would be in
 * production, instead of waiting on a body that never ends.
 */
export function forwardWorkerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  target: NodeURL,
  proxySharedSecret: string,
  logger: vite.Logger,
): void {
  const client = request.socket;
  // The client hung up while earlier middlewares ran.
  if (client.destroyed) {
    return;
  }
  const upstream = NodeHttp.request(target, {
    method: request.method,
    // `connection: close` alone is not enough: Node's and Bun's agents can
    // still hand the connection to the next request before it closes.
    agent: false,
    headers: {
      ...withoutHeaders(
        proxyRequestHeaders(request, target, proxySharedSecret),
        CONNECTION_HEADERS,
      ),
      connection: "close",
    },
  });
  // Watch the socket, not the response: Bun's `ServerResponse` emits no `close`
  // on a hang-up. Once the request body has been read, Bun reports no hang-up
  // at all, so there the Worker request runs to completion.
  let hungUp = false;
  const onHangUp = () => {
    hungUp = true;
    upstream.destroy();
  };
  client.once("close", onHangUp);
  let settled = false;
  const settle = () => {
    const first = !settled;
    settled = true;
    client.off("close", onHangUp);
    return first;
  };
  const fail = (error: Error) => {
    // A failure caused by the hang-up has nobody to answer.
    if (!settle() || hungUp) {
      return;
    }
    logger.error(`Worker request failed: ${error.message}`, { error, timestamp: true });
    if (response.headersSent) {
      // A partial body must not be completed with a 502.
      response.destroy();
      return;
    }
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("Bad Gateway");
  };
  // Without a listener a connection error is an unhandled `error` event, which
  // takes down the server. Requests in flight while the Worker runtime is
  // being replaced hit exactly that.
  upstream.on("error", fail);
  upstream.on("response", (workerResponse) => {
    // The upstream hop is closed after every response; the client's is not.
    response.writeHead(
      workerResponse.statusCode ?? 500,
      withoutHeaders(workerResponse.headers, HOP_BY_HOP_HEADERS),
    );
    workerResponse.pipe(response);
    // `pipe` alone would leave the client's response open forever when the
    // Worker's is cut short.
    finished(workerResponse, (error) => {
      if (error) {
        fail(error);
      } else {
        settle();
      }
    });
  });
  request.pipe(upstream);
}

/**
 * Headers that manage the client's connection to the Vite server. The rest of
 * the hop-by-hop set stays: Node re-frames the request body from
 * `transfer-encoding`.
 */
const CONNECTION_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
]);

const withoutHeaders = (
  headers: IncomingHttpHeaders,
  names: ReadonlySet<string>,
): IncomingHttpHeaders =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())));
