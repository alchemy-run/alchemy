import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { accepted } from "../../arm-action-fixture.ts";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";
import { MYSQL_TEST_LOCATION } from "../server.ts";

/**
 * A General Purpose server with a zone-redundant standby (failover needs
 * high availability; Burstable has none): stopped, started, restarted and
 * failed over.
 */
export const Server = Azure.MySQL.FlexibleServer("MySqlBindingsServer", {
  location: MYSQL_TEST_LOCATION,
  sku: { name: "Standard_D2ads_v5", tier: "GeneralPurpose" },
  highAvailability: { mode: "ZoneRedundant" },
});

/**
 * Effect-native Azure Function exercising every MySQL runtime-action binding
 * on a managed-identity host, one route per binding.
 */
export default class MySQLFunction extends Azure.Functions.Function<MySQLFunction>()(
  "MySQLFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const server = yield* Server;
    const stopServer = yield* Azure.MySQL.StopServer(server);
    const startServer = yield* Azure.MySQL.StartServer(server);
    const restartServer = yield* Azure.MySQL.RestartServer(server);
    const failoverServer = yield* Azure.MySQL.FailoverServer(server);

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
          case "/failover":
            return yield* accepted(failoverServer());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.MySQL.StopServerHttp,
        Azure.MySQL.StartServerHttp,
        Azure.MySQL.RestartServerHttp,
        Azure.MySQL.FailoverServerHttp,
      ),
    ),
  ),
) {}
