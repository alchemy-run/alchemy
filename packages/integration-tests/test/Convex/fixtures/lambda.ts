import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Convex from "@alchemy.run/convex";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { BindingDeployment } from "./resources.ts";

export default class ConvexBindingLambda extends Lambda.Function<ConvexBindingLambda>()(
  "ConvexBindingLambda",
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const connect = yield* Convex.Connect(BindingDeployment);
    const list = yield* Convex.Query(BindingDeployment);
    const add = yield* Convex.Mutation(BindingDeployment);
    const usage = yield* Convex.GetCurrentUsage(BindingDeployment);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const { pathname } = new URL(request.url, "http://lambda");
        if (pathname === "/connect") {
          return yield* HttpServerResponse.json({ url: yield* connect.url });
        }
        if (pathname === "/add") yield* add("messages:add", { body: "from a lambda" });
        if (pathname === "/usage") {
          const { metrics } = yield* usage();
          return yield* HttpServerResponse.json({ hasCalls: "functionCalls" in metrics });
        }
        return yield* HttpServerResponse.json(yield* list("messages:list"));
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Convex.ConnectHttp,
        Convex.QueryHttp,
        Convex.MutationHttp,
        Convex.GetCurrentUsageHttp,
      ),
    ),
  ),
) {}
