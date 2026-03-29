import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default Cloudflare.TanstackStart(
  "Website",
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getProfile: (name: string) =>
        Effect.flatMap(users.getByName(name), (user) => user.getProfile()),
      putProfile: (name: string, value: string) =>
        Effect.flatMap(users.getByName(name), (user) => user.putProfile(value)),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        return HttpServerResponse.text(yield* request.text);
      }),
    };
  }),
);

export const Users = Cloudflare.DurableObjectNamespace(
  "Users",
  Effect.gen(function* () {
    // Namespace
    // e.g. add resources & bindings here:
    // const queue = yield* Cloudflare.Queue("UsersQueue");

    return Effect.gen(function* () {
      // Instance
      const state = yield* Cloudflare.DurableObjectState;
      return {
        getProfile: () => state.storage.get<any>("Profile"),
        putProfile: (value: string) => state.storage.put("Profile", value),
      };
    });
  }),
);
