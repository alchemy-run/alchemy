import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import OpenCodeSession, { OpenCodeEffectSession, OpenCodeNativeSession } from "./Session.ts";

export default class OpenCodeApi extends Cloudflare.Worker<OpenCodeApi>()(
  "OpenCodeApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sessions = yield* OpenCodeSession;
    const effectSessions = yield* OpenCodeEffectSession;
    const nativeSessions = yield* OpenCodeNativeSession;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, name, action] = url.pathname.split("/");
        // A session's name says which harness it is on.
        const session = (
          name?.startsWith("oc-effect-")
            ? effectSessions
            : name?.startsWith("oc-native-")
              ? nativeSessions
              : sessions
        ).getByName("main");
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
                body.programs ?? [],
              ),
            });
          case "section":
            return yield* HttpServerResponse.json({ section: yield* session.section(name!) });
          case "tools":
            return yield* HttpServerResponse.json(yield* session.toolsUsed(name!));
          case "file":
            return yield* HttpServerResponse.json({
              text: yield* session.readFile(name!, body.path),
            });
          case "state":
            return yield* HttpServerResponse.json({ state: yield* session.sandboxState(name!) });
          case "start":
            yield* session.start(name!, body.text, body.tools);
            return yield* HttpServerResponse.json({ ok: true });
          case "abort":
            yield* session.abort(name!);
            return yield* HttpServerResponse.json({ ok: true });
          case "outcomes":
            return yield* HttpServerResponse.json({ outcomes: yield* session.outcomes(name!) });
          case "crash":
            yield* session.crash().pipe(Effect.ignore);
            return yield* HttpServerResponse.json({ ok: true });
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
