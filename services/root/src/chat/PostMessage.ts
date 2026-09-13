import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Head } from "../Head.ts";
import { ROOT } from "../Root.ts";

/**
 * POST /api/root — the human's message to the Head, on the Root
 * Thread. The POST only FIRES the round (the answer streams over the
 * session's `/attach` socket), so the response never waits for the
 * model.
 */
export const PostMessage = Effect.gen(function* () {
  const head = yield* Head;
  const exec = yield* Cloudflare.WorkerExecutionContext;

  return HttpRouter.add(
    "POST",
    "/api/root",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed({})),
      )) as { text?: string };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "text required" },
          { status: 400 },
        );
      }
      yield* exec.waitUntil(
        head.dispatch(text, { key: ROOT }).pipe(Effect.ignore),
      );
      return yield* HttpServerResponse.json({ ok: true }, { status: 202 });
    }),
  );
});
