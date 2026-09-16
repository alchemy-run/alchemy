import * as Effect from "effect/Effect";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * Run `handle` on every string frame a socket delivers until it closes.
 *
 * Effect ≥ 4.0.0-rc.113 dropped `socket.runString`; a `Socket` is now a
 * `reader` (a scoped `pull`) and a `writer`. This is the old shape over
 * the new one: acquire the string reader, then pull batches forever.
 * A close of any code completes normally — the socket is simply gone,
 * which is what every consumer here means by "done" — while a read
 * failure propagates. `onOpen` runs once the reader is acquired, i.e.
 * once the connection is up and frames can flow.
 */
export const runString = <E, R>(
  socket: Socket.Socket,
  handle: (frame: string) => Effect.Effect<void, E, R>,
  options?: { readonly onOpen?: Effect.Effect<unknown> },
): Effect.Effect<void, Socket.SocketError | E, R> =>
  Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket);
    if (options?.onOpen !== undefined) yield* options.onOpen;
    yield* Effect.forever(
      pull.pipe(
        Effect.flatMap((frames) =>
          Effect.forEach(frames, handle, { discard: true }),
        ),
      ),
    );
  }).pipe(
    Effect.catchIf(
      (error): error is Socket.SocketError =>
        Socket.isSocketError(error) && error.reason._tag === "SocketCloseError",
      () => Effect.void,
    ),
    Effect.scoped,
  );
