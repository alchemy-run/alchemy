import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { accepted } from "../../arm-action-fixture.ts";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";
import { POSTGRES_TEST_LOCATION } from "../server.ts";

/** The cheapest flexible server (Burstable B1ms): stopped, started and restarted. */
export const Server = Azure.PostgreSQL.FlexibleServer("PgBindingsServer", {
  location: POSTGRES_TEST_LOCATION,
});

/**
 * Effect-native Azure Function exercising every PostgreSQL runtime-action
 * binding on a managed-identity host, one route per binding.
 */
export default class PostgreSQLFunction extends Azure.Functions.Function<PostgreSQLFunction>()(
  "PostgreSQLFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const server = yield* Server;
    const stopServer = yield* Azure.PostgreSQL.StopServer(server);
    const startServer = yield* Azure.PostgreSQL.StartServer(server);
    const restartServer = yield* Azure.PostgreSQL.RestartServer(server);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        switch (new URL(request.url, "http://localhost").pathname) {
          case "/stop":
            return yield* accepted(stopServer());
          case "/start":
            return yield* accepted(startServer());
          case "/restart":
            return yield* accepted(restartServer());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.PostgreSQL.StopServerHttp,
        Azure.PostgreSQL.StartServerHttp,
        Azure.PostgreSQL.RestartServerHttp,
      ),
    ),
  ),
) {}
