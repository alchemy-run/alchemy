import { DurableObjectState } from "@/Celld/DurableObjectState.ts";
import { RpcDurableObject } from "@/Celld/RpcDurableObject.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RoomRpcs, Session } from "./rpcs.ts";

export class Room extends RpcDurableObject<Room>()("Room", {
  schema: RoomRpcs,
}) {}

export const RoomLive = Room.make(
  Effect.gen(function* () {
    const state = yield* DurableObjectState;
    return Effect.gen(function* () {
      const boots = ((yield* state.storage.get<number>("boots")) ?? 0) + 1;
      yield* state.storage.put("boots", boots);
      let active = 0;
      let finalized = 0;
      const release = yield* Deferred.make<void>();
      return RoomRpcs.toLayer({
        greet: ({ name }) => Effect.succeed(`Hello, ${name}`),
        session: ({ userId }) =>
          Effect.gen(function* () {
            const connectedAt = yield* Effect.sync(
              () => new Date("2026-01-02T03:04:05.000Z"),
            );
            for (const socket of yield* state.getWebSockets("alchemy:rpc")) {
              yield* socket
                .setAttachment(Session, { version: 1, userId, connectedAt })
                .pipe(Effect.orDie);
            }
          }),
        watch: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                active++;
              });
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  active--;
                  finalized++;
                }),
              );
              return Stream.concat(
                Stream.make(1),
                Stream.fromEffect(Deferred.await(release).pipe(Effect.as(2))),
              );
            }),
          ),
        release: () => Deferred.succeed(release, undefined).pipe(Effect.asVoid),
        stats: () =>
          Effect.gen(function* () {
            const sockets = yield* state.getWebSockets("alchemy:rpc");
            const session = sockets[0]
              ? yield* sockets[0]
                  .getAttachment(Session)
                  .pipe(
                    Effect.catchTag("WebSocketAttachmentError", () =>
                      Effect.succeed(undefined),
                    ),
                  )
              : undefined;
            return {
              boots,
              active,
              finalized,
              userId: session?.userId ?? null,
              dateDecoded: session?.connectedAt instanceof Date,
            };
          }),
      });
    });
  }),
);
