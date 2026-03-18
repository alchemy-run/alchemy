// @ts-nocheck
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Agent } from "./Agent.ts";

export const Api = Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    // bind the Agent DO to the Worker
    const agent = yield* Agent;
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (request.url.startsWith("/connect/")) {
        const [response, socket] = yield* Cloudflare.upgrade(request);

        // connect to a Durable Object web socket
        const roomId = request.url.split("/").pop()!;
        const room = yield* agent.getByName(roomId);
        const response = yield* room.fetch(request);
        return response;
      } else if (request.url.includes("/sandbox")) {
        // connect to a Container web socket
        // return yield* sandbox.fetch(request);
      } else if (request.url.startsWith("/profile/")) {
        // call RPC methods on a Durable Object
        const key = request.url.split("/").pop()!;
        const user = yield* agent.getByName(key);
        if (request.method == "GET") {
          const item = yield* user.getProfile();
          if (item) {
            return HttpServerResponse.text(item);
          }
        } else if (request.method == "PUT") {
          yield* user.putProfile(yield* request.text);
          return HttpServerResponse.text("OK", { status: 200 });
        } else {
          return HttpServerResponse.text("Method not allowed", { status: 405 });
        }
      }
      return HttpServerResponse.text("Not found", { status: 404 });
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        //
        Cloudflare.HttpServer,
      ),
    ),
  ),
);

export default Api;
