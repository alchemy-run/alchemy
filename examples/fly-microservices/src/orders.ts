import * as Fly from "alchemy/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Users from "./users.ts";

const ORDERS = [
  { id: "o1", userId: "u1", item: "keyboard" },
  { id: "o2", userId: "u2", item: "monitor" },
];

/**
 * Private Service that calls {@link Users}. Yielding `Users` in the props
 * makes Orders deploy after it and hands Orders its `privateUrl`.
 */
export default class Orders extends Fly.Service<Orders>()(
  "Orders",
  Effect.gen(function* () {
    const users = yield* Users;
    return {
      main: import.meta.url,
      public: false,
      network: yield* Fly.stackNetwork,
      env: { USERS_URL: users.privateUrl },
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const usersUrl = yield* Config.String("USERS_URL");
        const orders = yield* Effect.forEach(ORDERS, (order) =>
          HttpClient.get(`${usersUrl}/${order.userId}`).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((user) => ({ ...order, user })),
          ),
        );
        return yield* HttpServerResponse.json(orders);
      }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
    };
  }),
) {}
