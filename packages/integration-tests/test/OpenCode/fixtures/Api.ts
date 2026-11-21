import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import OpenCodeSession from "./Session.ts";

export default class OpenCodeApi extends Cloudflare.Worker<OpenCodeApi>()(
  "OpenCodeApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* OpenCodeSession;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, name, action] = url.pathname.split("/");
        const session = sessions.getByName("main");
        const body =
          request.method === "POST" ? ((yield* request.json) as Record<string, any>) : {};
        switch (action) {
          case "prompt":
            return yield* HttpServerResponse.json({
              text: yield* session.prompt(
                name!,
                body.text,
                body.tools,
                body.requestId,
                body.codeMode === true,
              ),
            });
          case "tools":
            return yield* HttpServerResponse.json(yield* session.toolsUsed(name!));
          case "file":
            return yield* HttpServerResponse.json({
              text: yield* session.readFile(name!, body.path),
            });
          case "state":
            return yield* HttpServerResponse.json({ state: yield* session.sandboxState(name!) });
          case "suspend":
            yield* session.suspend(name!);
            return yield* HttpServerResponse.json({ ok: true });
          case "kill":
            yield* session.kill(name!);
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
