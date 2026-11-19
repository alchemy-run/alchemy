import * as Cloudflare from "@alchemy.run/cloudflare";
import type * as DomainAi from "@alchemy.run/domain/Ai";
import type { BoardApi } from "@board/domain/BoardApi.api";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { BoardLive } from "./BoardLive.ts";
import { BoardRoutes } from "./BoardRoutes.ts";

/** The board's Worker: the Api on `/api` and its MCP server on `/mcp`. */
export default class BoardWorker extends Cloudflare.Worker<BoardWorker>()(
  "BoardWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // The hosted board and its middleware, resolved once at init for the routes.
    const board = yield* Effect.context<DomainAi.Services<typeof BoardApi>>();
    return {
      fetch: HttpRouter.toHttpEffect(
        BoardRoutes.pipe(Layer.provide(Layer.succeedContext(board)), Layer.orDie),
      ),
    };
  }).pipe(Effect.provide(BoardLive)),
) {}
