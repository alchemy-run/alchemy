import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Colleagues } from "./Ask.ts";
import { Calls } from "./Call.ts";

/**
 * A call's HTTP surface:
 *
 * - `GET  /api/calls/:id` — the call's transcript (the live tail
 *   rides the `/api/calls/:id/live` socket).
 * - `POST /api/calls/:id` — `{ text, to? }`: the human JOINING the
 *   call — the post lands in the transcript and is delivered to the
 *   member it addresses (default: the initiator).
 */
export const CallsApi = Effect.gen(function* () {
  const calls = yield* Calls;
  const colleagues = yield* Colleagues;
  const sessions = yield* AI.Sessions;

  const missing = HttpServerResponse.json(
    { error: "no such call" },
    { status: 404 },
  );

  const callId = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    return decodeURIComponent(String(params.id ?? ""));
  });

  const callGet = HttpRouter.add(
    "GET",
    "/api/calls/:id",
    Effect.gen(function* () {
      const found = yield* calls.read(yield* callId);
      return found === undefined
        ? yield* missing
        : yield* HttpServerResponse.json(found);
    }),
  );

  const callPost = HttpRouter.add(
    "POST",
    "/api/calls/:id",
    Effect.gen(function* () {
      const id = yield* callId;
      const call = yield* calls.read(id);
      if (call === undefined) return yield* missing;
      const request = yield* HttpServerRequest;
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed({})),
      )) as { text?: string; to?: string };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "text required" },
          { status: 400 },
        );
      }
      yield* calls.append(id, { author: "human", text });
      const to =
        typeof body.to === "string" && body.to.length > 0
          ? body.to
          : call.initiator;
      const resolved = yield* colleagues.resolve(to).pipe(
        Effect.map((target) => ({ target })),
        Effect.catch((error) => Effect.succeed({ error: error.message })),
      );
      if ("error" in resolved) {
        return yield* HttpServerResponse.json(
          { error: resolved.error },
          { status: 404 },
        );
      }
      yield* sessions.send(
        resolved.target.term,
        resolved.target.key,
        `[call ${id}] human: ${text}`,
        { wake: true },
      );
      return yield* HttpServerResponse.json(yield* calls.read(id));
    }),
  );

  return Layer.mergeAll(callGet, callPost);
});
