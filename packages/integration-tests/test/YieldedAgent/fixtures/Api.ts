import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import YieldedThreads from "./Threads.ts";

/** `/<object>/<thread>/<action>`: one Durable Object per `object`, many Threads in each. */
export default class YieldedApi extends Cloudflare.Worker<YieldedApi>()(
  "YieldedApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* YieldedThreads;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");
        const [, object, thread, action] = url.pathname.split("/");
        if (object === undefined || thread === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const threads = objects.getByName(object);
        const body =
          request.method === "POST" ? ((yield* request.json) as Record<string, any>) : {};
        switch (action) {
          case "ask":
            return yield* HttpServerResponse.json(yield* threads.ask(thread, body.text));
          case "file":
            return yield* HttpServerResponse.json(yield* threads.file(thread, body.text));
          case "events":
            return yield* HttpServerResponse.json(yield* threads.events(thread, body.text));
          case "history":
            return yield* HttpServerResponse.json(yield* threads.history(thread));
          case "state":
            return yield* HttpServerResponse.json({ state: yield* threads.sandboxState(thread) });
          case "suspend":
            yield* threads.suspend(thread);
            return yield* HttpServerResponse.json({ ok: true });
          case "remove":
            yield* threads.remove(thread);
            return yield* HttpServerResponse.json({ ok: true });
          case "crash":
            yield* threads.crash().pipe(Effect.ignore);
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
