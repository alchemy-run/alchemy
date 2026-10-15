import * as Cloudflare from "alchemy/Cloudflare";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { WebSocketRpcs, type Session } from "./websocket-schema.ts";

type SessionValue = typeof Session.Type;
type Attachment = {
  application?: string;
  __alchemyRpcWebSocket?: {
    version: number;
    clientId: number;
    pending: boolean;
    serialization: string;
  };
};

export class WebSocketObject extends Cloudflare.RpcDurableObject<WebSocketObject>()(
  "DeepWebSocketObject",
  { schema: WebSocketRpcs },
  Effect.gen(function* () {
    const version = yield* Cloudflare.Workers.VersionMetadata();
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const actorId = state.id.toString();
      let phase: "idle" | "ready" | "held" | "released" | "finished" = "idle";
      let session: SessionValue | undefined;
      let release: Deferred.Deferred<void> | undefined;
      let holdClosed: Deferred.Deferred<void> | undefined;
      let held = false;
      let calls = 0;
      let checksum = 0;

      const socketAndAttachment = Effect.gen(function* () {
        const sockets = yield* state.getWebSockets("alchemy:rpc");
        if (sockets.length !== 1)
          return yield* Effect.die(new Error("Exactly one benchmark socket required"));
        const socket = sockets[0]!;
        const attachment = yield* Effect.sync(() => socket.deserializeAttachment<Attachment>());
        const metadata = attachment?.__alchemyRpcWebSocket;
        if (
          !attachment ||
          !metadata ||
          metadata.version !== 1 ||
          !Number.isSafeInteger(metadata.clientId)
        ) {
          return yield* Effect.die(new Error("Missing native RPC socket metadata"));
        }
        return { socket, attachment, metadata };
      });

      return WebSocketRpcs.toLayer({
        begin: ({ runToken, count, metadataBytes }) =>
          Effect.gen(function* () {
            if (
              !/^[a-zA-Z0-9_-]{1,100}$/.test(runToken) ||
              (count !== 100 && count !== 1000) ||
              (metadataBytes !== 0 && metadataBytes !== 1024) ||
              (phase !== "idle" && phase !== "finished")
            ) {
              return yield* Effect.die(new Error("Invalid or overlapping benchmark session"));
            }
            const { socket, attachment, metadata } = yield* socketAndAttachment;
            yield* Effect.sync(() =>
              socket.serializeAttachment({ ...attachment, application: "x".repeat(metadataBytes) }),
            );
            const metadataVersion = yield* version;
            session = {
              runToken,
              count,
              metadataBytes,
              actorId,
              versionId: metadataVersion.id,
              connectionId: metadata.clientId,
            };
            release = yield* Deferred.make<void>();
            holdClosed = yield* Deferred.make<void>();
            phase = "ready";
            calls = 0;
            checksum = 0;
            held = false;
            console.log(JSON.stringify({ marker: "cpu-websocket-begin", ...session }));
            return session;
          }),
        hold: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (phase !== "ready" || !session || !release || !holdClosed)
                return yield* Effect.die(new Error("Session is not ready"));
              phase = "held";
              held = true;
              const current = session;
              const released = release;
              const closed = holdClosed;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  held = false;
                }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
              );
              return Stream.concat(
                Stream.make(current),
                Stream.fromEffect(Deferred.await(released)).pipe(Stream.drain),
              );
            }),
          ),
        short: ({ index }) =>
          Effect.sync(() => {
            if (
              !session ||
              phase !== "held" ||
              !held ||
              !Number.isSafeInteger(index) ||
              index !== calls + 1 ||
              index > session.count
            ) {
              throw new Error("Short call must be ordered while the held stream is active");
            }
            calls++;
            checksum += index;
            return index;
          }),
        release: () =>
          Effect.gen(function* () {
            if (!session || !release || phase !== "held" || !held || calls !== session.count) {
              return yield* Effect.die(new Error("Cannot release an incomplete session"));
            }
            phase = "released";
            return yield* Deferred.succeed(release, undefined);
          }),
        finish: () =>
          Effect.gen(function* () {
            // The protocol may send the stream Exit before running finalizers.
            // Wait for that finalizer rather than racing it or polling/retrying.
            if (holdClosed && phase === "released") yield* Deferred.await(holdClosed);
            if (
              !session ||
              phase !== "released" ||
              held ||
              calls !== session.count ||
              checksum !== (calls * (calls + 1)) / 2
            ) {
              return yield* Effect.die(new Error("Session did not finish correctly"));
            }
            const { attachment, metadata } = yield* socketAndAttachment;
            const metadataPreserved =
              attachment.application === "x".repeat(session.metadataBytes) &&
              metadata.clientId === session.connectionId &&
              metadata.serialization === "application/json";
            if (!metadataPreserved)
              return yield* Effect.die(new Error("Application attachment changed"));
            phase = "finished";
            const result = { ...session, calls, checksum, held, metadataPreserved };
            console.log(JSON.stringify({ marker: "cpu-websocket-end", ...result }));
            return result;
          }),
      });
    });
  }),
) {}
