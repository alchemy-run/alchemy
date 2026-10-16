import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import { EgressObject } from "./object.ts";

export default class EgressWorker extends Cloudflare.Worker<EgressWorker>()(
  "GitHubEgressWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* EgressObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const script = yield* request.text;
        const object = objects.getByName("egress");
        const issue = url.searchParams.get("issue");
        const result = issue
          ? yield* object.runOnIssue(Number(issue), script)
          : yield* object.run(script);
        return yield* HttpServerResponse.json(result);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
) {}
