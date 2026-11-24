/**
 * A TCP relay to a local port, for tests of what callers and runners do when
 * the process at the far end goes away. `cut` resets every connection through
 * it at once, as a process that exits does. `goSilent` makes it vanish the way
 * a removed Railway replica does: new connections are refused, and those
 * already open stay open but answer nothing (no data, no FIN, no RST), even
 * when the upstream side closes.
 */
import { connect, createServer, type Socket } from "node:net";
import * as Effect from "effect/Effect";

export interface Relay {
  readonly port: number;
  /** Reset every connection open through the relay now. */
  readonly cut: Effect.Effect<number>;
  /** Stop answering: refuse new connections, keep open ones open and silent. */
  readonly goSilent: Effect.Effect<void>;
  /** Bytes a connection sent after the relay went silent. */
  readonly swallowed: () => number;
}

export const relayTo = (upstreamPort: number) =>
  Effect.acquireRelease(
    Effect.callback<{ relay: Relay; close: () => void }>((resume) => {
      const open = new Set<Socket>();
      let silent = false;
      let swallowed = 0;
      const server = createServer((client) => {
        const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
        open.add(client);
        open.add(upstream);
        client.on("data", (chunk) => {
          if (silent) swallowed += chunk.length;
          else upstream.write(chunk);
        });
        upstream.on("data", (chunk) => {
          if (!silent) client.write(chunk);
        });
        const close = () => {
          if (silent) return;
          client.destroy();
          upstream.destroy();
          open.delete(client);
          open.delete(upstream);
        };
        client.on("error", close).on("close", close);
        upstream.on("error", close).on("close", close);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          Effect.succeed({
            relay: {
              port: typeof address === "object" && address !== null ? address.port : 0,
              cut: Effect.sync(() => {
                const count = open.size;
                for (const socket of open) socket.resetAndDestroy();
                open.clear();
                return count;
              }),
              goSilent: Effect.sync(() => {
                silent = true;
                server.close();
              }),
              swallowed: () => swallowed,
            },
            close: () => {
              silent = false;
              for (const socket of open) socket.destroy();
              server.close();
            },
          }),
        );
      });
    }),
    ({ close }) => Effect.sync(close),
  ).pipe(Effect.map(({ relay }) => relay));

/** A local TCP port nothing listens on, until something does. */
export const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});
