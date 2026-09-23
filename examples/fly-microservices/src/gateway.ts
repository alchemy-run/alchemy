import * as Fly from "alchemy/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Orders from "./orders.ts";
import Users from "./users.ts";

/**
 * The only public Service. It joins the same network as {@link Users} and
 * {@link Orders} and forwards `/users` and `/orders` to them.
 */
export default class Gateway extends Fly.Service<Gateway>()(
  "Gateway",
  Effect.gen(function* () {
    const users = yield* Users;
    const orders = yield* Orders;
    return {
      main: import.meta.url,
      network: yield* Fly.stackNetwork,
      env: { USERS_URL: users.privateUrl, ORDERS_URL: orders.privateUrl },
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://gateway").pathname;
        const upstream =
          path === "/users"
            ? yield* Config.String("USERS_URL")
            : path === "/orders"
              ? yield* Config.String("ORDERS_URL")
              : undefined;
        if (upstream === undefined) {
          return HttpServerResponse.text("try /users or /orders");
        }
        const body = yield* HttpClient.get(upstream).pipe(
          Effect.flatMap((response) => response.json),
        );
        return yield* HttpServerResponse.json(body);
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
    };
  }),
) {}
