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

/** The body of a bulk delete: `{ ids: string[] }`, empty when
 *  malformed. */
const readIds = (request: HttpServerRequest) =>
  request.json.pipe(
    Effect.catch(() => Effect.succeed({})),
    Effect.map((body) => {
      const ids = (body as { ids?: unknown }).ids;
      return Array.isArray(ids)
        ? ids.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
    }),
  );

/**
 * A session's transcript: the UIMessage projection, the redact-delete,
 * and the raw observation log.
 */
export const Transcript = Effect.gen(function* () {
  const sessions = yield* AI.Sessions;

  const sessionMessages = HttpRouter.add(
    "GET",
    "/api/chats/:id/messages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      // an unknown session is an EMPTY one — the conversation exists
      // from the first visit, before any message has been sent
      const log = yield* sessions.history(term, key);
      return yield* HttpServerResponse.json(AI.toUIMessages(log));
    }),
  );

  /**
   * Delete chat messages (`{ ids }`): resolve each UIMessage id
   * (`u-<seq>`, `a-<seq>`, `crash-<seq>`) to its observation span and
   * redact the union. Projection-only — the model's working context
   * is untouched.
   */
  const sessionMessagesDelete = HttpRouter.add(
    "DELETE",
    "/api/chats/:id/messages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const ids = yield* readIds(yield* HttpServerRequest);
      if (ids.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "ids required" },
          { status: 400 },
        );
      }
      const log = yield* sessions.history(term, key);
      const seqs = [
        ...new Set(ids.flatMap((id) => AI.observationSpan(log, id))),
      ];
      if (seqs.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "unknown messages" },
          { status: 404 },
        );
      }
      yield* sessions.redact(term, key, seqs);
      return yield* HttpServerResponse.json({ deleted: seqs.length });
    }),
  );

  const sessionLog = HttpRouter.add(
    "GET",
    "/api/chats/:id/log",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const limitRaw = new URL(request.url, "http://worker").searchParams.get(
        "limit",
      );
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      const log = yield* sessions.history(term, key);
      const observations =
        limit !== undefined && Number.isFinite(limit) && limit > 0
          ? log.slice(-limit)
          : log;
      return yield* HttpServerResponse.json(observations);
    }),
  );

  return Layer.mergeAll(sessionMessages, sessionMessagesDelete, sessionLog);
});
