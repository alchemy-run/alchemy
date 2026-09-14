/** Standard Effect HTTP group registration with an application user handler. */
import { Handlers } from "@/Git/index.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestApi, TestCaller } from "./test-auth.ts";

export const TestApiLive = HttpApiBuilder.group(TestApi, "github", (h) =>
  Effect.map(Handlers, (git) =>
    h.handleAll({
      ...git.github,
      user: () =>
        Effect.gen(function* () {
          const caller = yield* Effect.serviceOption(TestCaller);
          const user = Option.isSome(caller) ? caller.value.user : null;
          return user === null
            ? HttpServerResponse.jsonUnsafe(
                { message: "Requires authentication" },
                { status: 401 },
              )
            : HttpServerResponse.jsonUnsafe({
                login: user.name,
                id: 1,
                type: "User",
              });
        }),
    }),
  ),
);
