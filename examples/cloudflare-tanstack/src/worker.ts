import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class Backend extends Cloudflare.TanstackStart<Backend>()(
  "Backend",
  {
    main: import.meta.path,
  },
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
) {}

export class Users extends Cloudflare.DurableObjectNamespace<Users>()(
  "Users",
  Effect.gen(function* () {
    // Namespace
    // e.g. add resources & bindings here:
    // const queue = yield* Cloudflare.Queue("UsersQueue");

    return Effect.gen(function* () {
      // Instance
      const state = yield* Cloudflare.DurableObjectState;
      return {
        getProfile: () => state.storage.get<string>("Profile"),
        putProfile: (value: string) => state.storage.put("Profile", value),
      };
    });
  }),
) {}
