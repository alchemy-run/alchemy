import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import NanocodeSessions from "./Sessions.ts";

/** `/<object>/<session>/<action>`: one Durable Object per `object`, many sessions in each. */
export default class NanocodeApi extends Cloudflare.Worker<NanocodeApi>()(
  "NanocodeApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* NanocodeSessions;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, object, name, action] = url.pathname.split("/");
        if (object === undefined || name === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const sessions = objects.getByName(object);
        const body =
          request.method === "POST" ? ((yield* request.json) as Record<string, any>) : {};
        switch (action) {
          case "prompt":
            return yield* HttpServerResponse.json(
              yield* sessions.prompt(name, body.text, body.requestId),
            );
          case "events":
            return yield* HttpServerResponse.json(yield* sessions.events(name));
          case "file":
            return yield* HttpServerResponse.json({
              text: yield* sessions.readFile(name, body.path),
            });
          case "state":
            return yield* HttpServerResponse.json({
              state: yield* sessions.sandboxState(name),
            });
          case "suspend":
            yield* sessions.suspend(name);
            return yield* HttpServerResponse.json({ ok: true });
          case "remove":
            yield* sessions.remove(name);
            return yield* HttpServerResponse.json({ ok: true });
          case "crash":
            yield* sessions.crash().pipe(Effect.ignore);
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
