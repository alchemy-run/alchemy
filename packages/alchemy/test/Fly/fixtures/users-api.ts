import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const USERS_BODY = "users-over-flycast";

/** Private Service: reachable only at `privateUrl` over Flycast. */
export default class UsersApi extends Fly.Service<UsersApi>()(
  "UsersApi",
  {
    main: import.meta.url,
    region: "iad",
    public: false,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text(USERS_BODY)),
    };
  }),
) {}
