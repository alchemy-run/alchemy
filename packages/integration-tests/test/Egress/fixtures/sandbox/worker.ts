import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { EgressSandboxObject } from "./object.ts";

/**
 * POST /start?ttl=<ms> start the sandbox with both gateways' egress
 * POST /narrow        narrow it to gateway A
 * POST /sh            run the body as a shell script
 * GET  /running       whether the container runs
 * POST /abort         reset the Durable Object
 * POST /stop          stop the sandbox
 */
export default class EgressSandboxWorker extends Cloudflare.Worker<EgressSandboxWorker>()(
  "EgressSandboxWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* EgressSandboxObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const object = objects.getByName("sandbox");
        switch (url.pathname) {
          case "/start":
            yield* object.start(Number(url.searchParams.get("ttl") ?? 300_000));
            return HttpServerResponse.text("started");
          case "/narrow":
            yield* object.narrow();
            return HttpServerResponse.text("narrowed");
          case "/sh":
            return yield* HttpServerResponse.json(yield* object.sh(yield* request.text));
          case "/debug":
            return yield* HttpServerResponse.json(yield* object.debug());
          case "/running":
            return yield* HttpServerResponse.json(yield* object.running());
          case "/abort":
            yield* object.abort().pipe(Effect.ignore);
            return HttpServerResponse.text("aborted");
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
