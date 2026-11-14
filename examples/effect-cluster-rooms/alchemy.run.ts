import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import InviteLive from "./src/InviteLive.ts";
import RoomLive from "./src/RoomLive.ts";

export default Alchemy.Stack(
  "ClusterRooms",
  {
    providers: Layer.mergeAll(Docker.providers(), Cluster.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: "http://localhost:8080", service: api.name };
  }).pipe(Effect.provide(Layer.mergeAll(RoomLive, InviteLive))),
);
