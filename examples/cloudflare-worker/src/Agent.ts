import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import { Sandbox } from "./Sandbox.ts";

export default class Agent extends Cloudflare.DurableObjectNamespace<Agent>()(
  "Agents",
  Effect.gen(function* () {
    const sandbox = yield* Cloudflare.bindContainer(Sandbox);

    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      const container = yield* Cloudflare.runContainer(sandbox);

      const sessions = new Map<string, Cloudflare.DurableWebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const session = socket.deserializeAttachment<{ id: string }>();
        if (session) {
          sessions.set(session.id, socket);
        }
      }

      return {
        eval: (code: string) => container.eval(code),
        exec: (command: string) => container.exec(command),
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();
          const id = "TODO";
          socket.serializeAttachment({ id });
          sessions.set(id, socket);
          return response;
        }),
        webSocketMessage: Effect.fnUntraced(function* (
          socket: Cloudflare.DurableWebSocket,
          message: string | Uint8Array,
        ) {
          const session = socket.deserializeAttachment<{ id: string }>();
          if (!session) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);
          for (const peer of sessions.values()) {
            yield* peer.send(`[${session.id}] ${text}`);
          }
        }),
        webSocketClose: Effect.fnUntraced(function* (
          ws: Cloudflare.DurableWebSocket,
          code: number,
          reason: string,
          _wasClean: boolean,
        ) {
          const session = ws.deserializeAttachment<{ id: string }>();
          if (session) {
            sessions.delete(session.id);
          }
          yield* ws.close(code, reason);
        }),
      };
    });
  }),
) {}
