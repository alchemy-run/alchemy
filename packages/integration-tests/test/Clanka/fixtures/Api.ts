import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import ClankaConversations from "./Conversations.ts";

/** `/<object>/<conversation>/<action>`: one Durable Object per `object`, many conversations in each. */
export default class ClankaApi extends Cloudflare.Worker<ClankaApi>()(
  "ClankaApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* ClankaConversations;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, object, name, action] = url.pathname.split("/");
        if (object === undefined || name === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const conversations = objects.getByName(object);
        const body =
          request.method === "POST" ? ((yield* request.json) as Record<string, any>) : {};
        switch (action) {
          case "prompt":
            return yield* HttpServerResponse.json(yield* conversations.prompt(name, body.text));
          case "parts":
            return yield* HttpServerResponse.json(yield* conversations.parts(name, body.text));
          case "submit":
            yield* conversations.submit(name, body.text, body.requestId);
            return yield* HttpServerResponse.json({ ok: true });
          case "submitted":
            return yield* HttpServerResponse.json({
              run: yield* conversations.submitted(name, body.requestId),
            });
          case "history":
            return yield* HttpServerResponse.json(yield* conversations.history(name));
          case "file":
            return yield* HttpServerResponse.json({
              text: yield* conversations.readFile(name, body.path),
            });
          case "state":
            return yield* HttpServerResponse.json({
              state: yield* conversations.sandboxState(name),
            });
          case "suspend":
            yield* conversations.suspend(name);
            return yield* HttpServerResponse.json({ ok: true });
          case "remove":
            yield* conversations.remove(name);
            return yield* HttpServerResponse.json({ ok: true });
          case "crash":
            yield* conversations.crash().pipe(Effect.ignore);
            return yield* HttpServerResponse.json({ ok: true });
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }).pipe(
        // Answer with the failure, so a test can say what went wrong.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
