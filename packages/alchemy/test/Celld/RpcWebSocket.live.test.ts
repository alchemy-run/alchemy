import * as RpcWebSocketClient from "@/Celld/RpcWebSocketClient.ts";
import { beforeAll, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { RoomRpcs } from "./fixtures/rpc-websocket/rpcs.ts";
import { publishRpcFixture } from "./fixtures/rpc-websocket/publication.ts";

// Publication is opt-in only after the coordinator transfers the isolated Application.
const publish = process.env.CELLD_RPC_NATIVE_PUBLISH === "1";
const url = publish
  ? process.env.CELLD_NATIVE_WORKER_URL
  : process.env.CELLD_RPC_WORKER_URL;
if (publish) {
  beforeAll(
    () =>
      Effect.runPromise(
        publishRpcFixture({
          workerUrl: process.env.CELLD_NATIVE_WORKER_URL ?? "",
          nodeUrl: process.env.CELLD_NATIVE_NODE_URL ?? "",
          storageUrl: process.env.CELLD_NATIVE_STORAGE_URL ?? "",
        }).pipe(
          Effect.tap((application) =>
            Effect.log({
              rpcApplicationRevision: application.revision,
              workerName: application.workerName,
              url: application.url,
            }),
          ),
        ),
      ),
    120_000,
  );
}
class RoomClient extends Context.Service<RoomClient>()("CelldRpcRoomClient", {
  make: RpcClient.make(RoomRpcs),
}) {}

const connection = (name: string) =>
  Effect.sync(() => {
    const sockets: WebSocket[] = [];
    const layer = RpcWebSocketClient.layer(
      RoomClient,
      RoomRpcs,
      `${url!.replace(/^http/, "ws")}/rpc/${name}`,
      {
        protocol: { retryTransientErrors: false },
      },
    ).pipe(
      Layer.provide(
        Layer.succeed(Socket.WebSocketConstructor, (url) => {
          const socket = new WebSocket(url);
          sockets.push(socket);
          return socket;
        }),
      ),
    );
    return { layer, sockets };
  });

// The native daemon must set CELLD_IDLE_EVICT_S below 15; unset disables idle eviction.
it.live.skipIf(!publish && !url)(
  "Celld retains the same native socket and schema attachment across genuine hibernation",
  () =>
    Effect.gen(function* () {
      const observed = yield* connection("native-idle");
      yield* Effect.gen(function* () {
        const client = yield* RoomClient;
        yield* client.session({ userId: "sam" });
        const before = yield* client.stats();
        expect(before.userId).toBe("sam");
        expect(before.dateDecoded).toBe(true);
        expect(observed.sockets).toHaveLength(1);
        const socket = observed.sockets[0]!;
        const after = yield* Effect.sleep("15 seconds").pipe(
          Effect.andThen(client.stats().pipe(Effect.timeout("5 seconds"))),
          Effect.repeat({
            until: (stats) => stats.boots > before.boots,
            times: 2,
          }),
        );
        expect(after.boots).toBeGreaterThan(before.boots);
        expect(after.userId).toBe("sam");
        expect(after.dateDecoded).toBe(true);
        expect(yield* client.greet({ name: "awake" })).toBe("Hello, awake");
        expect(observed.sockets).toEqual([socket]);
        expect(socket.readyState).toBe(WebSocket.OPEN);
      }).pipe(Effect.provide(observed.layer));
    }),
  { timeout: 90_000 },
);

it.live.skipIf(!publish && !url)(
  "Celld sends the first stream item before release and finalizes interruption without disconnect",
  () =>
    Effect.gen(function* () {
      const observed = yield* connection("native-stream");
      yield* Effect.gen(function* () {
        const client = yield* RoomClient;
        const before = yield* client.stats();
        const first = yield* client
          .watch()
          .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"));
        expect(Array.from(first)).toEqual([1]);
        const after = yield* client.stats().pipe(
          Effect.repeat({
            until: (stats) =>
              stats.active === 0 && stats.finalized > before.finalized,
            schedule: Schedule.spaced("100 millis"),
            times: 8,
          }),
        );
        expect(after.active).toBe(0);
        expect(after.finalized).toBeGreaterThan(before.finalized);
        expect(yield* client.greet({ name: "still-open" })).toBe(
          "Hello, still-open",
        );
        expect(observed.sockets).toHaveLength(1);
        expect(observed.sockets[0]!.readyState).toBe(WebSocket.OPEN);
      }).pipe(Effect.provide(observed.layer));
    }),
  { timeout: 30_000 },
);
