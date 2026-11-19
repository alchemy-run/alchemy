import { BoardApi } from "@board/domain/BoardApi.api";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { BoardMcp } from "./BoardMcp.ts";
import { BoardToken, sessionRoute } from "./Session.ts";

/**
 * What the board's Worker serves: the typed Api on `/api` (the CLI and
 * Effect clients, with live reads over WebSockets) and the same Api as MCP
 * tools on `/mcp` (agents). `/api/session` signs the web app in with cookies.
 */
export const BoardRoutes = Layer.unwrap(
  Effect.map(Effect.all([BoardApi, BoardToken]), ([api, token]) => {
    const session = sessionRoute.pipe(Effect.provideService(BoardToken, token));
    return Layer.mergeAll(
      BoardMcp,
      HttpRouter.add("GET", "/api/session", session),
      HttpRouter.add("POST", "/api/session", session),
      HttpRouter.add("DELETE", "/api/session", session),
      // `/api/*` serves `/api` too.
      HttpRouter.add("*", "/api/*", api.fetch),
      HttpRouter.add("GET", "/", HttpServerResponse.text("board: /api and /mcp")),
    );
  }),
);
