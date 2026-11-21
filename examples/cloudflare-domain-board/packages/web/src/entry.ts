import * as Domain from "@alchemy.run/domain";
import { ActorName } from "@board/domain/Actor";
import { BoardApi } from "@board/domain/BoardApi.api";
import { ChannelId } from "@board/domain/Channel/Channel.id";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { Flags, init, Model, subscriptions, update, view } from "./Board.ts";

/** Who this browser is signed in as: `GET /api/session` reads its cookies. */
const signedInAs = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.get("/api/session");
  if (response.status !== 200) return Option.none<ActorName>();
  const body = yield* response.json;
  return Schema.decodeUnknownOption(Schema.Struct({ actor: ActorName }))(body).pipe(
    Option.map(({ actor }) => actor),
  );
}).pipe(
  Effect.catch(() => Effect.succeed(Option.none<ActorName>())),
  Effect.provide(FetchHttpClient.layer),
);

/**
 * The board Api for the life of the app, on this origin, so the browser sends
 * its session cookies with every call and every live read. Commands and live
 * reads share one WebSocket; each read pushes every change.
 */
const BoardConnection = BoardApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);

Runtime.run(
  Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    resources: BoardConnection.pipe(Layer.provideMerge(FetchHttpClient.layer)),
    container: document.getElementById("root"),
  }),
  {
    flags: Effect.gen(function* () {
      return {
        actor: yield* signedInAs,
        // `?channel=security` opens another channel.
        channel: ChannelId.make(new URLSearchParams(location.search).get("channel") ?? "dev"),
        // Names this page's commands and new threads, so each is unique across reloads.
        session: crypto.randomUUID().slice(0, 8),
      };
    }),
  },
);
