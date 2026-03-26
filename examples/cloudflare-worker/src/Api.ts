import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { Agent, AgentLive } from "./Agent.ts";

// declare the Api service with a tag + props
export class Api extends Cloudflare.Worker<Api>()("Api", {
  main: import.meta.path,
}) {}

export const ApiLive = Api.make(
  Effect.gen(function* () {
    // (Infrastructure dependencies are bound here)

    // bind the Agent DO to the Worker
    const agents = yield* Agent;

    return {
      fetch: Effect.gen(function* () {
        // (Business logic is implemented here and can reference bound infrastructure above)
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/connect/")) {
          // connect to a Durable Object web socket
          const agentId = request.url.split("/").pop()!;
          const agent = yield* agents.getByName(agentId);
          const response = yield* agent.fetch(request);
          return response;
        } else if (request.url.startsWith("/profile/")) {
          // call RPC methods on a Durable Object
          const key = request.url.split("/").pop()!;
          const agent = yield* agents.getByName(key);
          if (request.method == "GET") {
            const item = yield* agent.getProfile();
            if (item) {
              return HttpServerResponse.text(item);
            }
          } else if (request.method == "PUT") {
            yield* agent.putProfile(yield* request.text);
            return HttpServerResponse.text("OK", { status: 200 });
          } else {
            return HttpServerResponse.text("Method not allowed", {
              status: 405,
            });
          }
        }
        return HttpServerResponse.text("Not found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        //
        AgentLive,
      ),
    ),
  ),
);

export default ApiLive;
