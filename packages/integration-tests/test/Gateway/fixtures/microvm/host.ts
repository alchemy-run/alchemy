import * as AWS from "@alchemy.run/aws";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { GatewayedMicrovm } from "./sandbox.ts";

/** Runs a MicroVM of the program per request and returns its answer. */
export default class MicrovmHost extends AWS.Lambda.Function<MicrovmHost>()(
  "GatewayMicrovmHost",
  { main: import.meta.filename, timeout: Duration.seconds(120), functionUrl: true },
  Effect.gen(function* () {
    const runMicrovm = yield* AWS.Lambda.RunMicrovm(GatewayedMicrovm);
    const getMicrovm = yield* AWS.Lambda.GetMicrovm(GatewayedMicrovm);
    const terminateMicrovm = yield* AWS.Lambda.TerminateMicrovm(GatewayedMicrovm);
    const createAuthToken = yield* AWS.Lambda.CreateAuthToken(GatewayedMicrovm);
    return {
      fetch: Effect.gen(function* () {
        const vm = yield* runMicrovm({
          idlePolicy: {
            maxIdleDurationSeconds: 900,
            suspendedDurationSeconds: 300,
            autoResumeEnabled: true,
          },
        });
        return yield* Effect.gen(function* () {
          yield* getMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
            Effect.flatMap((m) =>
              m.state === "RUNNING" ? Effect.void : Effect.fail(new Error(`microvm ${m.state}`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
          );
          const { authToken } = yield* createAuthToken({
            microvmIdentifier: vm.microvmId,
            expirationInMinutes: 5,
            allowedPorts: [{ port: 8080 }],
          });
          const client = yield* HttpClient.HttpClient;
          const response = yield* client
            .get(`https://${vm.endpoint}/`, { headers: AWS.Lambda.microvmAuthHeaders(authToken) })
            .pipe(Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }));
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            headers: { "content-type": "application/json" },
          });
        }).pipe(
          Effect.ensuring(Effect.ignore(terminateMicrovm({ microvmIdentifier: vm.microvmId }))),
          Effect.provide(FetchHttpClient.layer),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Lambda.RunMicrovmHttp,
        AWS.Lambda.GetMicrovmHttp,
        AWS.Lambda.TerminateMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
      ),
    ),
  ),
) {}
