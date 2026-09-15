import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Posts } from "./Posts.ts";

/**
 * The company's conversation, read-only — one shape, one recursion:
 *
 * - `GET /api/posts`      — the newest root posts (`?limit=`)
 * - `GET /api/posts/:id`  — one post and everything beneath it
 */
export const PostsApi = Effect.gen(function* () {
  const posts = yield* Posts;

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/posts",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const limit = new URL(request.url, "http://worker").searchParams.get(
          "limit",
        );
        return yield* HttpServerResponse.json({
          posts: yield* posts.roots(limit === null ? undefined : Number(limit)),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/api/posts/:id",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const post = yield* posts.tree(
          decodeURIComponent(String(params.id ?? "")),
        );
        return post === undefined
          ? yield* HttpServerResponse.json(
              { error: "no such post" },
              { status: 404 },
            )
          : yield* HttpServerResponse.json(post);
      }),
    ),
  );
});
