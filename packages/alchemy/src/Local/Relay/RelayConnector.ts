import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import type { DevRelayOptions } from "../../AlchemyContext.ts";
import { UserFacingError } from "../../UserFacingError.ts";
import {
  AUTH_HEADER,
  CHUNK_SIZE,
  CONNECT_PATH,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  forwardableHeaders,
  NAMESPACE_PARAM,
  publicHost,
  type ControlFrame,
  type HelloFrame,
  type RequestFrame,
} from "./RelayProtocol.ts";

/**
 * The dev-sidecar half of the relay: ONE WebSocket to the relay for the
 * whole session, answering every public request it delivers from the local
 * ingress. Reconnects with backoff; a request in flight when the socket
 * drops is answered with an error by the relay and the client retries.
 */
export class RelayConnector extends Context.Service<
  RelayConnector,
  {
    readonly connect: (
      input: ConnectInput,
    ) => Effect.Effect<RelayConnection, RelayError, Scope.Scope>;
  }
>()("alchemy/Local/RelayConnector") {}

export interface ConnectInput extends DevRelayOptions {
  /** The local ingress every relayed request is forwarded to. */
  readonly target: URL;
  /**
   * Maps a public label (`api`) to the local ingress host it should be
   * served as (`api.localhost`), sent as the ingress route hint.
   */
  readonly localHost: (label: string) => string;
}

export interface RelayConnection {
  /** Handshake data: the relay's domain and public scheme. */
  readonly hello: HelloFrame;
  /** The public URL for `label`, e.g. `https://api.sam.dev.alchemy.run`. */
  readonly publicUrl: (label: string) => string;
}

export class RelayError extends Data.TaggedError("RelayError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly [UserFacingError] = true;
}

/** Header the ingress honours to pick a route regardless of `Host`. */
const ROUTE_HINT_HEADER = "x-alchemy-ingress-host";

const HELLO_TIMEOUT = "15 seconds";

interface Inflight {
  readonly controller: AbortController;
  bodyWriter?: WritableStreamDefaultWriter<Uint8Array>;
}

export const layer = Layer.succeed(
  RelayConnector,
  RelayConnector.of({
    connect: Effect.fn("RelayConnector.connect")(function* (input) {
      const connectUrl = new URL(CONNECT_PATH, input.url);
      connectUrl.protocol = connectUrl.protocol === "http:" ? "ws:" : "wss:";
      connectUrl.searchParams.set(NAMESPACE_PARAM, input.namespace);

      // Resolves on the first successful handshake; later reconnects only log.
      const first = yield* Deferred.make<HelloFrame, RelayError>();
      let latestHello: HelloFrame | undefined;

      const session = Effect.gen(function* () {
        const socket = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              new WebSocket(connectUrl, {
                // Bun and Node (undici) both accept `headers` here.
                headers: input.token
                  ? { [AUTH_HEADER]: `Bearer ${input.token}` }
                  : {},
              } as unknown as string[]),
            catch: (cause) =>
              new RelayError({
                message: `Could not open a WebSocket to the dev relay at ${connectUrl}.`,
                cause,
              }),
          }),
          (socket) =>
            Effect.sync(() => socket.close(1000, "dev session ended")),
        );
        socket.binaryType = "arraybuffer";
        const closed = yield* Deferred.make<void, RelayError>();
        const hello = yield* Deferred.make<HelloFrame, RelayError>();
        const inflight = new Map<number, Inflight>();

        const send = (data: string | Uint8Array) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(data);
        };

        const handle = (frame: ControlFrame) => {
          switch (frame.t) {
            case "hello":
              latestHello = frame;
              Deferred.doneUnsafe(hello, Effect.succeed(frame));
              return;
            case "req":
              void serve(frame);
              return;
            case "end": {
              const entry = inflight.get(frame.id);
              void entry?.bodyWriter?.close().catch(() => {});
              return;
            }
            case "abort": {
              const entry = inflight.get(frame.id);
              if (entry) {
                inflight.delete(frame.id);
                entry.controller.abort();
                void entry.bodyWriter?.abort().catch(() => {});
              }
              return;
            }
            case "res":
              return;
          }
        };

        const serve = async (frame: RequestFrame): Promise<void> => {
          const controller = new AbortController();
          const entry: Inflight = { controller };
          inflight.set(frame.id, entry);
          let body: ReadableStream<Uint8Array> | undefined;
          if (frame.body) {
            const stream = new TransformStream<Uint8Array, Uint8Array>();
            entry.bodyWriter = stream.writable.getWriter();
            body = stream.readable;
          }
          const headers = new Headers();
          for (const [name, value] of frame.headers)
            headers.append(name, value);
          headers.set(ROUTE_HINT_HEADER, input.localHost(frame.label));
          try {
            const response = await fetch(new URL(frame.url, input.target), {
              method: frame.method,
              headers,
              body,
              redirect: "manual",
              signal: controller.signal,
              // Streaming request bodies need half-duplex mode in undici.
              ...(body ? { duplex: "half" } : {}),
            } as RequestInit);
            const hasBody = response.body !== null;
            send(
              encodeControl({
                t: "res",
                id: frame.id,
                status: response.status,
                headers: forwardableHeaders(response.headers),
                body: hasBody,
              }),
            );
            if (hasBody) {
              const reader = response.body!.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                for (let o = 0; o < value.byteLength; o += CHUNK_SIZE) {
                  send(
                    encodeChunk(frame.id, value.subarray(o, o + CHUNK_SIZE)),
                  );
                }
              }
              send(encodeControl({ t: "end", id: frame.id }));
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              send(
                encodeControl({
                  t: "abort",
                  id: frame.id,
                  message: `alchemy dev could not reach ${frame.label}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                }),
              );
            }
          } finally {
            inflight.delete(frame.id);
          }
        };

        socket.addEventListener("message", (event) => {
          const data = (event as MessageEvent).data as string | ArrayBuffer;
          if (typeof data === "string") {
            handle(decodeControl(data));
          } else {
            const { id, chunk } = decodeChunk(data);
            const entry = inflight.get(id);
            void entry?.bodyWriter
              ?.write(new Uint8Array(chunk))
              .catch(() => {});
          }
        });
        socket.addEventListener("close", (event) => {
          const { code, reason } = event as CloseEvent;
          const error = new RelayError({
            message: `Dev relay connection closed (${code}${reason ? `: ${reason}` : ""}).`,
          });
          Deferred.doneUnsafe(hello, Effect.fail(error));
          Deferred.doneUnsafe(
            closed,
            code === 1000 ? Effect.void : Effect.fail(error),
          );
        });
        socket.addEventListener("error", (event) => {
          const detail = (event as { message?: string; error?: unknown })
            .message;
          const error = new RelayError({
            message: `Dev relay connection to ${connectUrl} failed${detail ? `: ${detail}` : "."}`,
            cause: (event as { error?: unknown }).error,
          });
          Deferred.doneUnsafe(hello, Effect.fail(error));
          Deferred.doneUnsafe(closed, Effect.fail(error));
        });

        const greeted = yield* Deferred.await(hello).pipe(
          Effect.timeoutOrElse({
            duration: HELLO_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new RelayError({
                  message: `The dev relay at ${connectUrl} did not complete the handshake within ${HELLO_TIMEOUT}.`,
                }),
              ),
          }),
        );
        yield* Deferred.succeed(first, greeted);
        yield* Effect.logInfo(
          `Connected to the dev relay: ${greeted.scheme}://<name>.${greeted.namespace}.${greeted.domain}`,
        );
        // Serve until the socket closes.
        yield* Deferred.await(closed);
      }).pipe(Effect.scoped);

      // Keep the connection alive for the whole dev session: reconnect with
      // backoff on drops. The first attempt's failure surfaces to the caller
      // (bad URL / token) instead of retrying forever silently.
      yield* session.pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            if (!(yield* Deferred.isDone(first))) {
              yield* Deferred.fail(first, error);
            } else {
              yield* Effect.logWarning(`${error.message} Reconnecting…`);
            }
          }),
        ),
        Effect.retry({
          while: () => Deferred.isDoneUnsafe(first),
          schedule: Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("10 seconds"),
          ]),
        }),
        Effect.catch(() => Effect.void),
        Effect.forkScoped,
      );

      const hello = yield* Deferred.await(first);
      return {
        hello,
        publicUrl: (label) => {
          const h = latestHello ?? hello;
          return `${h.scheme}://${publicHost(label, h.namespace, h.domain)}`;
        },
      } satisfies RelayConnection;
    }),
  }),
);
