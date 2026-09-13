import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** `${term}:${key}` → the session it names (the key may contain `:`). */
const parseSessionId = (id: string): { term: string; key: string } => {
  const at = id.indexOf(":");
  return at < 0
    ? { term: id, key: id }
    : { term: id.slice(0, at), key: id.slice(at + 1) };
};

/**
 * The stop button: abort the session's round in flight. The session
 * stays alive — the next message opens a fresh round. A parked
 * session is a no-op.
 */
export const Interrupt = Effect.gen(function* () {
  const sessions = yield* AI.Sessions;

  return HttpRouter.add(
    "POST",
    "/api/chats/:id/interrupt",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      yield* sessions.interrupt(term, key);
      // the old channel's "(stopped)" row went with the channel itself
      return yield* HttpServerResponse.json({ ok: true });
    }),
  );
});
