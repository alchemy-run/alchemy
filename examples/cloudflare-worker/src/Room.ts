import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * Ephemeral chat room: broadcasts each text message to every connected client.
 * Uses Durable Object storage of WebSocket attachments so sessions survive hibernation.
 */
export default class Room extends Cloudflare.DurableObjectNamespace<Room>()(
  "Rooms",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      const sessions = new Map<
        string,
        {
          socket: Cloudflare.DurableWebSocket;
          write: (
            chunk: Uint8Array | string,
          ) => Effect.Effect<void, Socket.SocketError>;
        }
      >();

      for (const socket of yield* state.getWebSockets()) {
        const attachment = yield* socket.deserializeAttachment<{
          id: string;
        }>();
        if (attachment) {
          sessions.set(attachment.id, {
            socket,
            write: yield* socket.writer,
          });
        }
      }

      console.log("[Room] DO instance initialized, existing sessions:", sessions.size);

      return {
        fetch: Effect.gen(function* () {
          console.log("[Room] fetch handler called, attempting upgrade");
          const [response, socket] = yield* Cloudflare.upgrade();
          const id = crypto.randomUUID();
          console.log("[Room] upgrade succeeded, session id =", id);
          yield* socket.serializeAttachment({ id });
          sessions.set(id, {
            socket,
            write: yield* socket.writer,
          });
          console.log("[Room] returning response, status =", response.status);
          return response;
        }),
        webSocketMessage: Effect.fnUntraced(function* (
          socket: Cloudflare.DurableWebSocket,
          message: string | Uint8Array,
        ) {
          const attachment = yield* socket.deserializeAttachment<{
            id: string;
          }>();
          if (!attachment) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          const label = attachment.id.slice(0, 8);
          for (const peer of sessions.values()) {
            yield* peer.write(`[${label}] ${text}`);
          }
        }),
        webSocketClose: Effect.fnUntraced(function* (
          ws: Cloudflare.DurableWebSocket,
          code: number,
          reason: string,
          _wasClean: boolean,
        ) {
          const attachment = yield* ws.deserializeAttachment<{
            id: string;
          }>();
          if (attachment) {
            sessions.delete(attachment.id);
          }
          yield* ws.close(code, reason);
        }),
      };
    });
  }),
) {}
