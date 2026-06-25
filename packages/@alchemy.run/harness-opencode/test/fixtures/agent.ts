import type {
  CodingAgentError,
  CodingAgentEvent,
  CodingAgentMessage,
} from "alchemy/AI";
import { CodingAgentContainer } from "alchemy/Cloudflare";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * The Agent Durable Object: a thin durable wrapper around the embedded
 * {@link CodingAgentContainer} that fans the agent's event stream out to clients
 * over **hibernatable WebSockets**.
 *
 * Control methods (`send`, `interrupt`, `readFile`, `listFiles`, `poll`) are
 * plain RPC forwards to the container. Events, however, are pushed: a client
 * opens a WebSocket (the DO completes the handshake with `Cloudflare.upgrade()`)
 * and the DO holds a single **streaming RPC** connection open to the container —
 * `container.events()` returns a `Stream`, which a detached forwarder fiber
 * drains, broadcasting each event as a JSON frame to every connected socket.
 *
 * The sockets are hibernatable: Cloudflare keeps them open while it evicts the
 * idle DO from memory, so the socket set is rehydrated from
 * `state.getWebSockets()` every time the instance is reconstructed.
 */
export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agent",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const container = yield* CodingAgentContainer;

    return Effect.gen(function* () {
      // Sockets survive hibernation on the runtime, not in this map — rehydrate
      // the live set every time the instance is reconstructed.
      const sockets = new Set<Cloudflare.DurableWebSocket>();
      for (const socket of yield* state.getWebSockets()) sockets.add(socket);

      const broadcast = (event: CodingAgentEvent) =>
        Effect.forEach(
          sockets,
          (socket) =>
            socket.send(JSON.stringify(event)).pipe(
              // A dead socket must not tear down the forwarder; drop it.
              Effect.catchCause(() =>
                Effect.sync(() => {
                  sockets.delete(socket);
                }),
              ),
            ),
          { discard: true },
        );

      // Hold one streaming RPC connection open to the container and fan its
      // events out to all sockets. Forked detached so it outlives the request
      // scope and lives for the instance's lifetime; guarded so we never run two.
      let forwarding = false;
      const ensureForwarder = Effect.suspend(() => {
        if (forwarding) return Effect.void;
        forwarding = true;
        return Effect.forkDetach(
          container.events().pipe(
            Stream.runForEach(broadcast),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                forwarding = false;
                return cause;
              }).pipe(Effect.asVoid),
            ),
          ),
        ).pipe(Effect.asVoid);
      });

      // Woke up with sockets still attached (post-hibernation) — resume pushing.
      if (sockets.size > 0) yield* ensureForwarder;

      return {
        send: (
          input: CodingAgentMessage,
        ): Effect.Effect<void, CodingAgentError> => container.send(input),
        interrupt: (): Effect.Effect<void, CodingAgentError> =>
          container.interrupt(),
        poll: (
          cursor: number,
        ): Effect.Effect<
          { events: ReadonlyArray<CodingAgentEvent>; cursor: number },
          CodingAgentError
        > => container.poll(cursor),
        readFile: (
          path: string,
        ): Effect.Effect<string | null, CodingAgentError> =>
          container.readFile(path),
        listFiles: (
          path?: string,
        ): Effect.Effect<ReadonlyArray<string>, CodingAgentError> =>
          container.listFiles(path),

        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          sockets.add(socket);
          yield* ensureForwarder;
          return response;
        }),

        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.DurableWebSocket,
          code: number,
          reason: string,
        ) {
          sockets.delete(socket);
          yield* socket.close(code, reason);
        }),
      };
    });
  }).pipe(
    Effect.provide(
      Cloudflare.layerContainer(CodingAgentContainer, { enableInternet: true }),
    ),
  ),
) {}
