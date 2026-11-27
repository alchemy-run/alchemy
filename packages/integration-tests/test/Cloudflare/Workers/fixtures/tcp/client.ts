import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import TcpEchoWorker from "./echo.ts";

const decoder = new TextDecoder();

/**
 * Effect-native caller of {@link TcpEchoWorker}: `GET /?message=ping` opens a
 * TCP connection over the `Cloudflare.Workers.Connect` service binding,
 * sends the message, and returns everything the echo Worker wrote back until
 * the echoed line arrives.
 */
export default class TcpClientWorker extends Cloudflare.Worker<TcpClientWorker>()(
  "TcpClientWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const echo = yield* Cloudflare.Workers.Connect(TcpEchoWorker);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const message = new URL(request.url, "http://x").searchParams.get("message") ?? "ping";
        const socket = yield* echo("echo.internal:7");
        const { pull } = yield* socket.reader;
        const writer = yield* socket.writer;
        yield* writer.write(`${message}\n`);
        let received = "";
        const expected = `${message.toUpperCase()}\n`;
        while (!received.includes(expected)) {
          for (const chunk of yield* pull) {
            received += typeof chunk === "string" ? chunk : decoder.decode(chunk);
          }
        }
        return HttpServerResponse.text(received);
      }).pipe(
        Effect.scoped,
        Effect.timeout("20 seconds"),
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(`client failed: ${cause}`, { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.ConnectBinding)),
) {}
