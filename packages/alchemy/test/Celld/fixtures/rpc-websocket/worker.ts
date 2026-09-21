import { Worker } from "@/Celld/Worker.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Room, RoomLive } from "./object.ts";

/** Publish on a dedicated Celld Application; the live test uses CELLD_RPC_WORKER_URL. */
export default class RpcSocketWorker extends Worker<RpcSocketWorker>()(
  "RpcSocketWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const rooms = yield* Room;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(
          () => new URL(request.url, "http://celld"),
        );
        const name = /^\/rpc\/([a-zA-Z0-9_-]+)$/.exec(url.pathname)?.[1];
        if (!name) return HttpServerResponse.empty({ status: 404 });
        return yield* rooms.fetch(name, request);
      }),
    };
  }).pipe(Effect.provide(RoomLive)),
) {}
