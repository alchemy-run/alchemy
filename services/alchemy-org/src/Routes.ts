import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** `${term}:${key}` → the session it names (the key may contain `:`). */
const parseSessionId = (id: string): { term: string; key: string } => {
  const at = id.indexOf(":");
  return at < 0
    ? { term: id, key: id }
    : { term: id.slice(0, at), key: id.slice(at + 1) };
};

/**
 * The engineer's HTTP surface — deliberately tiny. The board comes
 * from the {@link AI.SessionIndex} (the one cross-session aggregate);
 * each transcript comes from the session's OWN storage
 * (`ThreadStorage.observations` shaped by `AI.toUIMessages`); the
 * live tail rides the session socket (`/attach`, wired by the
 * entrypoint).
 */
export const engineerRoutes = Effect.gen(function* () {
  const index = yield* AI.SessionIndex;
  const storage = yield* AI.ThreadStorage;

  const listSessions = HttpRouter.add(
    "GET",
    "/api/chats",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* index.list());
    }),
  );

  const sessionMessages = HttpRouter.add(
    "GET",
    "/api/chats/:id/messages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      // an unknown session is an EMPTY one — the chat exists from the
      // first visit, before any message has been sent
      const handle = yield* storage.open(term, key);
      const log = yield* handle.observations(0);
      return yield* HttpServerResponse.json(AI.toUIMessages(log));
    }),
  );

  // the RAW observation log — driver vocabulary, crashes included.
  // The debugging poll: `messages` shapes for the UI, this tells the
  // truth (`?limit=N` tails the last N observations).
  const sessionLog = HttpRouter.add(
    "GET",
    "/api/chats/:id/log",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const handle = yield* storage.open(term, key);
      const log = yield* handle.observations(0);
      const limitRaw = new URL(request.url, "http://engineer").searchParams.get(
        "limit",
      );
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      return yield* HttpServerResponse.json({
        log:
          limit !== undefined && Number.isFinite(limit) && limit > 0
            ? log.slice(-limit)
            : log,
      });
    }),
  );

  return Layer.mergeAll(listSessions, sessionMessages, sessionLog);
});
