import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import { MicrovmSandboxObject } from "./object.ts";

/**
 * POST /start?size=&ttl=  start the sandbox (or re-apply to the running one)
 * POST /narrow            narrow it to REPO_A
 * POST /sh                run the body as a shell script (inside the program)
 * POST /exec?script=      sandbox.exec the script, with the body on stdin
 * GET  /running           whether the MicroVM runs
 * GET  /debug             what the Durable Object stores
 * POST /stop              stop the sandbox
 */
export default class MicrovmSandboxWorker extends Cloudflare.Worker<MicrovmSandboxWorker>()(
  "MicrovmSandboxWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* MicrovmSandboxObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const object = objects.getByName("sandbox");
        switch (url.pathname) {
          case "/start":
            yield* object.start(
              (url.searchParams.get("size") ?? "small") as "small" | "large",
              Number(url.searchParams.get("ttl") ?? 300_000),
            );
            return HttpServerResponse.text("started");
          case "/narrow":
            yield* object.narrow();
            return HttpServerResponse.text("narrowed");
          case "/sh":
            return yield* HttpServerResponse.json(yield* object.sh(yield* request.text));
          case "/exec":
            return yield* HttpServerResponse.json(
              yield* object.exec(url.searchParams.get("script") ?? "true", yield* request.text),
            );
          case "/running":
            return yield* HttpServerResponse.json(yield* object.running());
          case "/debug":
            return yield* HttpServerResponse.json(yield* object.debug());
          case "/stop":
            yield* object.stop();
            return HttpServerResponse.text("stopped");
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
