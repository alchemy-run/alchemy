import * as Cloudflare from "alchemy-effect/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// TODO(sam): support this: https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point
export default class Worker extends Cloudflare.TanstackStart<Worker>()(
  "Backend",
  // Effect<Rpc>
  {
    main: import.meta.filename,
    // projectDir: "./apps/frontend",
  },
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getProfile: (name: string) => users.getByName(name).getProfile(),
      putProfile: (name: string, value: string) =>
        users.getByName(name).putProfile(value),
      fetch: Effect.gen(function* () {
        return HttpServerResponse.text("Hello World");
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
