import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const USERS = [
  { id: "u1", name: "Ada" },
  { id: "u2", name: "Grace" },
];

/**
 * Private Service. `public: false` gives it no internet address, and
 * `network: Fly.stackNetwork` puts it on a private network that only this
 * stage's Services join. Other Services call it at `privateUrl`.
 */
export default class Users extends Fly.Service<Users>()(
  "Users",
  Effect.gen(function* () {
    return {
      main: import.meta.url,
      public: false,
      network: yield* Fly.stackNetwork,
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const id = new URL(request.url, "http://users").pathname.slice(1);
        if (id.length === 0) return yield* HttpServerResponse.json(USERS);
        const user = USERS.find((candidate) => candidate.id === id);
        return user === undefined
          ? HttpServerResponse.text("not found", { status: 404 })
          : yield* HttpServerResponse.json(user);
      }),
    };
  }),
) {}
