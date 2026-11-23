import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

const decoder = new TextDecoder();

/**
 * Effect-native TCP echo Worker. Each connection gets a greeting naming the
 * address the caller connected to, then every chunk it sends back
 * upper-cased, until the caller closes.
 */
export default class TcpEchoWorker extends Cloudflare.Worker<TcpEchoWorker>()(
  "TcpEchoWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      connect: (socket) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => socket.raw.opened);
          const { pull } = yield* socket.reader;
          const writer = yield* socket.writer;
          yield* writer.write(`hello ${info.localAddress ?? "?"}\n`);
          while (true) {
            for (const chunk of yield* pull) {
              const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
              yield* writer.write(text.toUpperCase());
            }
          }
          // A pull fails once the caller closes, clean close included.
        }).pipe(Effect.catch(() => Effect.void)),
    };
  }),
) {}
