import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

/**
 * A workerd TCP socket as an Effect {@link Socket.Socket}: read batches with
 * `socket.reader`, write with `socket.writer`. `raw` is the
 * underlying workerd `Socket`, for APIs that take one (piping its
 * `readable`/`writable` into another socket keeps TCP half-closes intact).
 *
 * Both directions use it: the socket a Worker's `connect` handler receives,
 * and the socket an outbound `connect(address)` opens.
 */
export interface TcpSocket extends Socket.Socket {
  /** The underlying workerd `Socket`. */
  readonly raw: cf.Socket;
}

/**
 * Wrap a workerd `Socket` as a {@link TcpSocket}. The streams are acquired
 * once `opened` resolves, on the first read; an open failure surfaces as a
 * `SocketError` from `run`.
 */
export const fromWorkerdSocket = (raw: cf.Socket): TcpSocket => {
  // `fromTransformStream` snapshots fiber context, then waits to acquire
  // the streams until a consumer opens the reader. `runSync` is only that
  // snapshot — connection still happens on first `socket.reader`.
  const socket = Effect.tryPromise({
    try: () =>
      Promise.resolve(raw.opened).then(
        () =>
          ({
            readable: raw.readable,
            writable: raw.writable,
          }) as unknown as Socket.InputTransformStream,
      ),
    catch: (cause) =>
      Socket.SocketError.make({
        reason: Socket.SocketOpenError.make({ kind: "Unknown", cause }),
      }),
  }).pipe(Socket.fromTransformStream, Effect.runSync);
  return Object.assign(socket, { raw });
};
