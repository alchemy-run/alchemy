import * as NodeHttp from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream";
import type { URL as NodeURL } from "node:url";
import type * as vite from "vite";
import { proxyRequestHeaders } from "./forwarded-host.ts";

/**
 * Forwards a dev or preview server request to the Worker runtime at `target`
 * and relays the Worker's response.
 *
 * When the client hangs up, the Worker request is cancelled, as it would be in
 * production. Otherwise a stream the client abandoned (a closed page's SSE
 * subscription) keeps running in workerd.
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
    headers: proxyRequestHeaders(request, target, proxySharedSecret),
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
    response.writeHead(workerResponse.statusCode ?? 500, workerResponse.headers);
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
