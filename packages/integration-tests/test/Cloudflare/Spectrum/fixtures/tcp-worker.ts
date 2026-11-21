import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

const decoder = new TextDecoder();

/**
 * The origin of a Worker-origin Spectrum application: greets each TCP
 * connection, then echoes every chunk back upper-cased until the client
 * closes.
 */
export default class SpectrumTcpWorker extends Cloudflare.Worker<SpectrumTcpWorker>()(
  "SpectrumTcpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      connect: (socket) =>
        Effect.gen(function* () {
          const { pull } = yield* socket.reader;
          const writer = yield* socket.writer;
          yield* writer.write("hello\n");
          while (true) {
            for (const chunk of yield* pull) {
              const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
              yield* writer.write(text.toUpperCase());
            }
          }
          // A pull fails once the client closes, clean close included.
        }).pipe(Effect.catch(() => Effect.void)),
    };
  }),
) {}
