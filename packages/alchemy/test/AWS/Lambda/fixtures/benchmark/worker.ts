import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BenchExternal } from "./external-image.ts";
import { Sandbox } from "../microvm/sandbox.ts";

/**
 * Cloudflare Worker cold-start benchmark host — the cross-cloud analog of the
 * Lambda {@link import("./orchestrator.ts")}. Same routes, same measurement,
 * but driven from a Worker: binding the AWS MicroVM operations causes Alchemy
 * to provision an IAM User + AccessKey + assume-role Role (once per worker) and
 * assume that role at runtime (see `MicrovmBinding.ts`). This measures the
 * Worker → MicroVM cold-start path.
 */
export default Cloudflare.Worker(
  "MicrovmBenchWorker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const runEffectful = yield* AWS.Lambda.RunMicrovm(Sandbox);
    const getEffectful = yield* AWS.Lambda.GetMicrovm(Sandbox);
    const authEffectful = yield* AWS.Lambda.CreateAuthToken(Sandbox);
    const termEffectful = yield* AWS.Lambda.TerminateMicrovm(Sandbox);

    const runExternal = yield* AWS.Lambda.RunMicrovm(BenchExternal);
    const getExternal = yield* AWS.Lambda.GetMicrovm(BenchExternal);
    const authExternal = yield* AWS.Lambda.CreateAuthToken(BenchExternal);
    const termExternal = yield* AWS.Lambda.TerminateMicrovm(BenchExternal);

    const boot = (
      run: typeof runEffectful,
      get: typeof getEffectful,
      auth: typeof authEffectful,
      term: typeof termEffectful,
      reachable: (
        endpoint: string,
        authToken: Record<
          string,
          string | Redacted.Redacted<string> | undefined
        >,
      ) => Effect.Effect<unknown, any, any>,
    ) =>
      Effect.gen(function* () {
        const start = yield* Effect.sync(() => Date.now());
        const vm = yield* run({
          idlePolicy: {
            maxIdleDurationSeconds: 900,
            suspendedDurationSeconds: 300,
            autoResumeEnabled: true,
          },
        });
        return yield* Effect.gen(function* () {
          yield* get({ microvmIdentifier: vm.microvmId }).pipe(
            Effect.flatMap((m) =>
              m.state === "RUNNING"
                ? Effect.void
                : Effect.fail(new Error(`microvm ${m.state}`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
            Effect.orDie,
          );
          const { authToken } = yield* auth({
            microvmIdentifier: vm.microvmId,
            expirationInMinutes: 5,
            allowedPorts: [{ port: 8080 }],
          });
          yield* reachable(vm.endpoint, authToken).pipe(
            Effect.retry({
              schedule: Schedule.exponential("250 millis"),
              times: 12,
            }),
            Effect.orDie,
          );
          const ms = (yield* Effect.sync(() => Date.now())) - start;
          return yield* HttpServerResponse.json({ ms });
        }).pipe(
          Effect.ensuring(
            term({ microvmIdentifier: vm.microvmId }).pipe(Effect.ignore),
          ),
          Effect.provide(FetchHttpClient.layer),
        );
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm");

        if (url.pathname === "/boot/effectful") {
          return yield* boot(
            runEffectful,
            getEffectful,
            authEffectful,
            termEffectful,
            (endpoint, authToken) =>
              Effect.gen(function* () {
                const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {
                  endpoint,
                  authToken,
                });
                return yield* sandbox.hello("bench");
              }),
          );
        }

        if (url.pathname === "/boot/external") {
          return yield* boot(
            runExternal,
            getExternal,
            authExternal,
            termExternal,
            (endpoint, authToken) =>
              Effect.gen(function* () {
                const client = yield* HttpClient.HttpClient;
                const res = yield* client.get(`https://${endpoint}/`, {
                  headers: AWS.Lambda.microvmAuthHeaders(authToken),
                });
                return yield* res.text;
              }),
          );
        }

        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Lambda.RunMicrovmHttp,
        AWS.Lambda.GetMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
        AWS.Lambda.TerminateMicrovmHttp,
      ),
    ),
  ),
);
