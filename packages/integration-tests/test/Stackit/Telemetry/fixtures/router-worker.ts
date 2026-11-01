import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const AuditLogs = Stackit.Telemetry.Router("TelemetryBindingsRouter", {});

export const Siem = AuditLogs.pipe(
  Effect.flatMap((router) =>
    Stackit.Telemetry.Destination("TelemetryBindingsDestination", {
      routerId: router.routerId,
      config: {
        type: "OpenTelemetry",
        uri: "https://otlp.example.com/otlp/v1/logs",
        bearerToken: "alchemy-test-token",
      },
    }),
  ),
);

export const LinkToken = AuditLogs.pipe(
  Effect.flatMap((router) =>
    Stackit.Telemetry.AccessToken("TelemetryBindingsToken", { routerId: router.routerId }),
  ),
);

/**
 * A Cloudflare Worker with every Telemetry Router binding. One route per binding; each
 * answers `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class TelemetryBindingsWorker extends Cloudflare.Worker<TelemetryBindingsWorker>()(
  "StackitTelemetryBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const router = yield* AuditLogs;
    const destination = yield* Siem;
    const token = yield* LinkToken;
    const getRouter = yield* Stackit.Telemetry.GetRouter(router);
    const listRouters = yield* Stackit.Telemetry.ListRouters(router);
    const getDestination = yield* Stackit.Telemetry.GetDestination(destination);
    const listDestinations = yield* Stackit.Telemetry.ListDestinations(router);
    const getAccessToken = yield* Stackit.Telemetry.GetAccessToken(token);
    const listAccessTokens = yield* Stackit.Telemetry.ListAccessTokens(router);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        switch (url.pathname) {
          case "/get-router":
            return yield* respond(
              getRouter({}).pipe(Effect.map((live) => ({ id: live.id, status: live.status }))),
            );
          case "/list-routers":
            return yield* respond(
              listRouters({ pageSize: 100 }).pipe(
                Effect.map(({ telemetryRouters }) => telemetryRouters.map((live) => live.id)),
              ),
            );
          case "/get-destination":
            return yield* respond(
              getDestination({}).pipe(
                Effect.map((live) => ({ id: live.id, type: live.config.configType })),
              ),
            );
          case "/list-destinations":
            return yield* respond(
              listDestinations({ pageSize: 100 }).pipe(
                Effect.map(({ destinations }) => destinations.map((live) => live.id)),
              ),
            );
          case "/get-access-token":
            return yield* respond(
              getAccessToken({}).pipe(Effect.map((live) => ({ id: live.id, status: live.status }))),
            );
          case "/list-access-tokens":
            return yield* respond(
              listAccessTokens({ pageSize: 100 }).pipe(
                Effect.map(({ accessTokens }) => accessTokens.map((live) => live.id)),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.Telemetry.GetRouterHttp,
        Stackit.Telemetry.ListRoutersHttp,
        Stackit.Telemetry.GetDestinationHttp,
        Stackit.Telemetry.ListDestinationsHttp,
        Stackit.Telemetry.GetAccessTokenHttp,
        Stackit.Telemetry.ListAccessTokensHttp,
      ),
    ),
  ),
) {}
