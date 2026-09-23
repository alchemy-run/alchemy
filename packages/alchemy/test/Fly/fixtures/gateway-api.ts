import * as Fly from "@/Fly";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import UsersApi from "./users-api.ts";

/** Public Service that proxies every request to the private {@link UsersApi}. */
export default class GatewayApi extends Fly.Service<GatewayApi>()(
  "GatewayApi",
  Effect.gen(function* () {
    const users = yield* UsersApi;
    return {
      main: import.meta.url,
      region: "iad",
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
