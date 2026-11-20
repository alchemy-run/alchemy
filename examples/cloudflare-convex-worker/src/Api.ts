// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Backend } from "./Backend.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const list = yield* Convex.Query(Backend);
    const add = yield* Convex.Mutation(Backend);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method === "POST") {
          yield* add("messages:add", { body: yield* request.text });
        }
        return yield* HttpServerResponse.json(yield* list("messages:list"));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Convex.QueryHttp, Convex.MutationHttp))),
) {}
