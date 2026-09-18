import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Posts } from "./Posts.ts";

/**
 * The company's conversation, read-only — a flat stream:
 *
 * - `GET /api/posts`      — the stream, oldest first (`?channel=`, `?limit=`)
 * - `GET /api/posts/:id`  — one message, its direct replies, and the
 *   THREAD it lives in (the root of its reference chain)
 * - `GET /api/posts/:id/workspaces` — the workspaces ACTIVE in the
 *   thread the message lives in (created there by any agent)
 * - `GET /api/posts/:id/edges` — the association graph touching the
 *   message, either direction (answers, about, continues)
 */
export const PostsApi = Effect.gen(function* () {
  const posts = yield* Posts;

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/edges",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const channel = url.searchParams.get("channel") ?? "root";
        return yield* HttpServerResponse.json(
          yield* posts.edgesInChannel(channel),
        );
      }),
    ),
    HttpRouter.add(
      "GET",
      "/api/posts/:id/edges",
      Effect.gen(function* () {
        const { id } = (yield* HttpRouter.params) as { id: string };
        return yield* HttpServerResponse.json(yield* posts.edgesOf(id));
      }),
    ),
    HttpRouter.add(
      "GET",
      "/api/posts",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const search = new URL(request.url, "http://worker").searchParams;
        const limit = search.get("limit");
        const channel = search.get("channel");
        return yield* HttpServerResponse.json({
          posts: yield* posts.list({
            ...(channel === null ? {} : { channel }),
            ...(limit === null ? {} : { limit: Number(limit) }),
          }),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/api/posts/:id",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const id = decodeURIComponent(String(params.id ?? ""));
        const post = yield* posts.get(id);
        return post === undefined
          ? yield* HttpServerResponse.json(
              { error: "no such post" },
              { status: 404 },
            )
          : yield* HttpServerResponse.json({
              post,
              replies: yield* posts.replies(id),
              thread: (yield* posts.ancestors(id))[0]?.id ?? id,
            });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/api/posts/:id/workspaces",
      Effect.gen(function* () {
        const params = yield* HttpRouter.params;
        const id = decodeURIComponent(String(params.id ?? ""));
        // any member id resolves — the link table keys on the root
        const thread = (yield* posts.ancestors(id))[0]?.id ?? id;
        return yield* HttpServerResponse.json({
          workspaces: yield* posts.workspacesOf(thread),
        });
      }),
    ),
  );
});
