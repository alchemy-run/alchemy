import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const EXIT_MARKER = "__EXIT__:";

/**
 * The session's MicroVM coordinates: its endpoint host and the already-resolved
 * auth header map (from `AWS.Lambda.microvmAuthHeaders`). The DO speaks only
 * the VM's data plane — it never touches AWS credentials, so these plain
 * strings are all it needs.
 */
export interface MicrovmCoords {
  readonly endpoint: string;
  readonly headers: Record<string, string>;
}

/**
 * One terminal session. The hosting Worker provisions the session's MicroVM
 * (assume-role control plane) and hands the coordinates here via the `init`
 * RPC; the same VM is reused for every command in the session (no re-boot per
 * command).
 *
 * Each command received on the WebSocket is POSTed to the VM's streaming
 * `/exec` route; the combined stdout/stderr is forwarded back to the browser
 * chunk-by-chunk as the process produces it.
 */
export default class ShellSession extends Cloudflare.DurableObject<ShellSession>()(
  "ShellSession",
  Effect.gen(function* () {
    // The session's VM coordinates, set by the `init` RPC and reused for every
    // command in the session. Held in the instance closure — a session is one
    // live DO instance for its lifetime; a hibernation wake drops the binding,
    // at which point the browser reconnects and the Worker provisions afresh.
    let coords: MicrovmCoords | undefined;

    return Effect.gen(function* () {
      const send = (socket: Cloudflare.WebSocket, text: string) =>
        socket.send(text).pipe(Effect.ignore);

      const runCommand = (socket: Cloudflare.WebSocket, command: string) =>
        Effect.gen(function* () {
          if (!coords) {
            yield* send(socket, "\r\n[session has no microvm]\r\n");
            return;
          }
          const { endpoint, headers } = coords;
          const client = yield* HttpClient.HttpClient;
          const request = HttpClientRequest.post(
            `https://${endpoint}/exec`,
          ).pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJsonUnsafe({ command }),
          );

          yield* HttpClientResponse.stream(client.execute(request)).pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.gen(function* () {
                // The VM ends its stream with a `\n__EXIT__:<code>\n` trailer;
                // render it as a prompt-style status line, not raw text.
                const marker = chunk.indexOf(EXIT_MARKER);
                if (marker === -1) {
                  yield* send(socket, chunk);
                  return;
                }
                const before = chunk.slice(0, marker);
                const code = chunk
                  .slice(marker + EXIT_MARKER.length)
                  .trim()
                  .split(/\s/)[0];
                if (before) yield* send(socket, before);
                yield* send(socket, `\r\n[exit ${code}]\r\n`);
              }),
            ),
          );
        }).pipe(
          Effect.catch((error) =>
            send(socket, `\r\n[error] ${String(error)}\r\n`),
          ),
          Effect.provide(FetchHttpClient.layer),
        );

      return {
        /** Pin this session to a provisioned MicroVM (called by the Worker). */
        init: (next: MicrovmCoords) =>
          Effect.sync(() => {
            coords = next;
          }),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          yield* send(
            socket,
            "connected to microvm — type a command and press enter\r\n",
          );
          return response;
        }),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const command =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          if (!command.trim()) return;
          yield* runCommand(socket, command.trim());
        }),
        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          yield* socket.close(code, reason).pipe(Effect.ignore);
        }),
      };
    });
  }),
) {}
