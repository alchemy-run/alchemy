import * as Fly from "@/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import SecureUsers from "./secure-users.ts";

/** Public Service on the stack network that proxies to {@link SecureUsers}. */
export default class SecureGateway extends Fly.Service<SecureGateway>()(
  "SecureGateway",
  Effect.gen(function* () {
    const users = yield* SecureUsers;
    return {
      main: import.meta.url,
      region: "iad",
      network: yield* Fly.stackNetwork,
      guest: { cpuKind: "shared" as const, cpus: 1, memoryMb: 256 },
      env: { USERS_URL: users.privateUrl },
    };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const usersUrl = yield* Config.String("USERS_URL");
        const body = yield* HttpClient.get(usersUrl).pipe(
          Effect.flatMap((response) => response.text),
          Effect.provide(FetchHttpClient.layer),
        );
        return HttpServerResponse.text(body);
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.text(String(error), { status: 502 }),
          ),
        ),
      ),
    };
  }),
) {}
