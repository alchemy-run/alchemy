import { BoardApi } from "@board/domain/BoardApi.api";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { BoardMcp } from "./BoardMcp.ts";

/**
 * What the board's Worker serves: the typed Api on `/api` (the CLI and
 * Effect clients, with live reads over WebSockets) and the same Api as MCP
 * tools on `/mcp` (agents).
 */
export const BoardRoutes = Layer.unwrap(
  Effect.map(BoardApi, (api) =>
    Layer.mergeAll(
      BoardMcp,
      // `/api/*` serves `/api` too.
      HttpRouter.add("*", "/api/*", api.fetch),
      HttpRouter.add("GET", "/", HttpServerResponse.text("board: /api and /mcp")),
    ),
  ),
);
