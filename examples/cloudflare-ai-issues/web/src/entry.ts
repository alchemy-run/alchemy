import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { WebApi } from "../../src/Board/WebApi.api.ts";
import { SessionRead } from "../../src/SessionRead.ts";
import {
  Flags,
  init,
  Listed,
  Model,
  REMEMBERED,
  Sessions,
  subscriptions,
  update,
} from "./Board.ts";
import { issueIn } from "./Location.ts";
import { view } from "./View.ts";

/**
 * The board's Api for the life of the app. Commands go over HTTP. Each live
 * read is a WebSocket to the Durable Object that owns what it reads.
 */
const BoardConnection = WebApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
);

/** An issue's session, read from the board's Worker on the page's own origin. */
const SessionsOverHttp = Layer.succeed(Sessions, {
  read: (issueId, after) =>
    Effect.tryPromise(() =>
      fetch(`${location.origin}/sessions/${encodeURIComponent(issueId)}?after=${after}`).then(
        (response) => response.json(),
      ),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionRead))),
});

Runtime.run(
  Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    resources: Layer.mergeAll(BoardConnection, SessionsOverHttp),
    container: document.getElementById("root"),
  }),
  {
    flags: Effect.sync(() => ({
      // The issue the address names is opened: a refresh or a shared link resumes it.
      issueId: issueIn(location.href),
      // Short, and names this page's commands and issues: each is unique across reloads.
      page: crypto.randomUUID().slice(0, 8),
      // The list as the last visit left it, on screen before the board answers.
      issues: Option.getOrElse(
        Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Listed)))(
          localStorage.getItem(REMEMBERED) ?? "[]",
        ),
        () => [],
      ),
    })),
  },
);
