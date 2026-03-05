// @ts-nocheck
import { Http } from "alchemy-effect";
import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServiceMap from "effect/ServiceMap";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class Users extends ServiceMap.Service<
  Users,
  {
    getUser: (userId: string) => Effect.Effect<{
      firstName: string;
      lastName: string;
    }>;
  }
>()("Users") {}

export const UsersDurableObject = Layer.effect(
  Users,
  Effect.gen(function* () {
    const users = yield* Cloudflare.DurableObjectNamespace(
      "Users",
      Effect.gen(function* () {
        const state = yield* Cloudflare.DurableObjectState;
        return {
          getProfile: () =>
            state.storage.kv.get("profile") as {
              firstName: string;
              lastName: string;
            },
        };
      }),
    );
    return Users.of({
      getUser: (userId) =>
        users
          .getByName(userId)
          .pipe(Effect.flatMap((user) => user.getProfile())),
    });
  }),
);

export default Effect.gen(function* () {
  const users = yield* Cloudflare.DurableObjectNamespace(
    "Users",
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      return {
        getCart: () =>
          state.storage.kv.get("cart") as {
            items: string[];
          },
      };
    }),
  );

  yield* Http.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      if (request.method === "GET" && request.url.includes("/users")) {
        const user = yield* users.getByName(request.url.split("/").pop()!);
        const cart = user.getCart();

        return yield* HttpServerResponse.json(cart).pipe(
          Effect.catch(() =>
            Effect.succeed(
              HttpServerResponse.text("Internal server error", { status: 500 }),
            ),
          ),
        );
      }
      return HttpServerResponse.text("Not found", { status: 404 });
    }),
  );

  return {
    main: import.meta.filename,
  } as Cloudflare.WorkerProps;
}).pipe(
  Effect.provide(Layer.mergeAll(Cloudflare.HttpServer)),
  Cloudflare.Worker("JobWorker"),
);
