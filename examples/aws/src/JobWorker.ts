import { Http } from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as UrlParams from "effect/unstable/http/UrlParams";
import { Users, UsersDurableObject } from "./Users.ts";

export default Effect.gen(function* () {
  const users = yield* Users;

  yield* Http.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (request.method === "GET" && request.url.includes("/user/")) {
        const params = yield* request.urlParamsBody;
        const userId = UrlParams.getFirst(params, "userId");
        if (!userId) {
          return HttpServerResponse.text("Invalid user ID", {
            status: 400,
          });
        }
        const user = yield* users.getUser(userId);

        if (!user) {
          return HttpServerResponse.text("User not found", {
            status: 404,
          });
        }
        return yield* HttpServerResponse.json(user);
      }
      return HttpServerResponse.text("Not found", { status: 404 });
    }),
  );

  return {
    main: import.meta.filename,
  } as Cloudflare.WorkerProps;
}).pipe(
  Effect.provide(Layer.mergeAll(Cloudflare.HttpServer, UsersDurableObject)),
  Cloudflare.Worker("JobWorker"),
);
