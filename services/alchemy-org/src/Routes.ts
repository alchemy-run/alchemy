/**
 * The coder's HTTP surface — deliberately tiny: the chat transcript in
 * the AI SDK UIMessage protocol (snapshot hydration for the UI; the
 * live tail rides the run-socket `/attach` door the entrypoint adds),
 * and the raw observation log for debugging.
 */
import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const coderRoutes = Effect.gen(function* () {
  const chats = yield* AI.Chats;

  const listChats = HttpRouter.add(
    "GET",
    "/api/chats",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* chats.list());
    }),
  );

  const chatMessages = HttpRouter.add(
    "GET",
    "/api/chats/:id/messages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      // snapshot is driver vocabulary; the AI SDK shaping is the
      // adapter's (`AI.toUIMessages`). An unknown chat is an EMPTY
      // one — the single chat exists from the first visit, before
      // any message has been sent.
      const snapshot = yield* chats.snapshot(id);
      return yield* HttpServerResponse.json(
        snapshot === undefined
          ? []
          : AI.toUIMessages(snapshot.log, snapshot.streaming),
      );
    }),
  );

  // the RAW observation log — driver vocabulary, crashes included.
  // The debugging poll: `messages` shapes for the UI, this tells the
  // truth (`?limit=N` tails the last N observations).
  const chatLog = HttpRouter.add(
    "GET",
    "/api/chats/:id/log",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      const snapshot = yield* chats.snapshot(id);
      if (snapshot === undefined) {
        return yield* HttpServerResponse.json(
          { error: `unknown chat: ${id}` },
          { status: 404 },
        );
      }
      const limitRaw = new URL(request.url, "http://coder").searchParams.get(
        "limit",
      );
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      const log =
        limit !== undefined && Number.isFinite(limit) && limit > 0
          ? snapshot.log.slice(-limit)
          : snapshot.log;
      return yield* HttpServerResponse.json({
        log,
        streaming: snapshot.streaming,
      });
    }),
  );

  return Layer.mergeAll(listChats, chatMessages, chatLog);
});
