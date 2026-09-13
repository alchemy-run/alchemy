import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Asks } from "./Asks.ts";

/**
 * The ASK TREE's wire — what the UI's reddit-style thread rendering
 * reads:
 *
 * - `GET /api/asks`          — root asks, newest first (`?limit=`)
 * - `GET /api/asks/:id/tree` — one ask's SUBTREE, children nested
 *   (an ask card polls its subtree while the chain runs)
 */
export const AsksApi = Effect.gen(function* () {
  const asks = yield* Asks;

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/asks",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const limit = new URL(request.url, "http://worker").searchParams.get(
          "limit",
        );
        return yield* HttpServerResponse.json({
          asks: yield* asks.roots(
            limit === null ? undefined : Number(limit) || undefined,
          ),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/api/asks/:id/tree",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const tree = yield* asks.tree(String(params.id ?? ""));
        return tree === undefined
          ? yield* HttpServerResponse.json(
              { error: "no such ask" },
              { status: 404 },
            )
          : yield* HttpServerResponse.json(tree);
      }),
    ),
  );
});
