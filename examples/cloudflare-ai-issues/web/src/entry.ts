import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { WebApi } from "../../src/Board/WebApi.api.ts";
import { Flags, init, Model, subscriptions, update, view } from "./Issue.ts";
import { issueOf } from "./Location.ts";

/**
 * The board's Api for the life of the app. Commands go over HTTP. Each live
 * read is a WebSocket to the Durable Object that owns what it reads.
 */
const BoardConnection = WebApi.layerClient.pipe(
  Layer.provide(Domain.protocolWebSocket(`${location.origin}/api`)),
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, Socket.layerWebSocketConstructorGlobal)),
);

Runtime.run(
  Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    resources: BoardConnection,
    container: document.getElementById("root"),
  }),
  {
    flags: Effect.sync(() => {
      const { issueId, url } = issueOf(location.href, () => `web-${Date.now()}`);
      // Keep the issue in the address bar: a refresh resumes it.
      history.replaceState(null, "", url);
      return {
        issueId,
        // Names this page's commands, so each is unique even across reloads.
        page: crypto.randomUUID(),
      };
    }),
  },
);
