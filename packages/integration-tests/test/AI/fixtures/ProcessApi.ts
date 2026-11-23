import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { OpenCodeAgents, PiAgents, type Ask } from "./Hosts.ts";

/** Drives the processes on each harness over HTTP: `POST /<harness>/<process>/<key>/<action>`. */
export default class ProcessApi extends Cloudflare.Worker<ProcessApi>()(
  "ProcessApi",
  { main: import.meta.url },
  Effect.gen(function* () {
    const pi = yield* PiAgents;
    const opencode = yield* OpenCodeAgents;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, harness, name, key, action] = new URL(request.url, "http://api").pathname.split(
          "/",
        );
        if (name === undefined || key === undefined || action === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const body = (yield* request.json) as Omit<Ask, "action">;
        const agents = (harness === "pi" ? pi : opencode).getByName("main");
        const answer = yield* agents.ask(name, key, { ...body, action });
        return answer === undefined
          ? HttpServerResponse.text("not found", { status: 404 })
          : yield* HttpServerResponse.json(answer);
      }).pipe(
        // Answer with the failure, so a test can say what went wrong.
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
