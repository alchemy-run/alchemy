import { AsyncLocalStorage } from "node:async_hooks";
import * as http from "node:http";

// Neon's host builds the handler's Request without a signal and, for
// identity-encoded responses, waits on `drain` forever after the client
// disconnects instead of cancelling the body
// (https://github.com/neondatabase/neon-pkgs/issues/636). The handler runs
// inside the host's `request` event, so each event is entered with its Node
// response in scope and the disconnect is observed directly.
const responses = new AsyncLocalStorage<http.ServerResponse>();
let installed = false;

/** Track the Node response of every `request` event; idempotent. */
export const installDisconnectTracking = () => {
  if (installed) return;
  installed = true;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (
    this: http.Server,
    event: string | symbol,
    ...args: unknown[]
  ) {
    return event === "request" && args[1] instanceof http.ServerResponse
      ? responses.run(args[1], () => emit.call(this, event, ...args))
      : emit.call(this, event, ...args);
  } as typeof emit;
};

/**
 * The request's signal, also aborted when the client disconnects before the
 * response finishes. Falls back to `request.signal` outside a tracked event.
 */
export const disconnectSignal = (request: Request): AbortSignal => {
  const response = responses.getStore();
  if (!response) return request.signal;
  const controller = new AbortController();
  // Node closes the response on disconnect; Bun only closes its socket. The
  // socket is kept alive across requests, so detach once the response finishes.
  const socket = response.socket;
  const detach = () => {
    response.off("close", onClose);
    response.off("finish", detach);
    socket?.off("close", onClose);
  };
  const onClose = () => {
    detach();
    if (response.writableFinished) return;
    controller.abort(new DOMException("The client disconnected", "AbortError"));
    // Release the host's pump; it then reads the aborted body and ends.
    if (response.listenerCount("drain") > 0) response.emit("drain");
  };
  if (response.destroyed || socket?.destroyed) onClose();
  else {
    response.once("close", onClose);
    response.once("finish", detach);
    socket?.once("close", onClose);
  }
  return AbortSignal.any([request.signal, controller.signal]);
};

/** Pipe a body through `signal` so a disconnect cancels its producer. */
export const abortableResponse = (response: Response, signal: AbortSignal): Response =>
  response.body
    ? new Response(
        response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }),
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      )
    : response;
