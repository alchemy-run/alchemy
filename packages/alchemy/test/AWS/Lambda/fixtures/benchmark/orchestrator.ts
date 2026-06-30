import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Sandbox } from "../microvm/sandbox.ts";

/**
 * Cold-start benchmark orchestrator (the AWS analog of the Cloudflare Container
 * benchmark's Durable Object). Each `GET /boot?name=X` launches ONE fresh
 * MicroVM from the {@link Sandbox} image, measures — from inside the Lambda —
 * the time from `RunMicrovm` until the in-VM server is reachable (its `hello`
 * RPC answers), then terminates it. The elapsed delta is the MicroVM
 * "started and reachable" latency, directly comparable to the Container
 * benchmark's "DO start → reachable" number.
 */
export default class BenchOrchestrator extends AWS.Lambda.Function<BenchOrchestrator>()(
  "MicrovmBenchOrchestrator",
  {
    main: import.meta.filename,
    url: true,
    // Each /boot waits for the MicroVM to become reachable within one
    // invocation; cold starts can take a while, so allow plenty of room.
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const runMicrovm = yield* AWS.Lambda.RunMicrovm(Sandbox);
    const getMicrovm = yield* AWS.Lambda.GetMicrovm(Sandbox);
    const createAuthToken = yield* AWS.Lambda.CreateAuthToken(Sandbox);
    const terminateMicrovm = yield* AWS.Lambda.TerminateMicrovm(Sandbox);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/boot") {
          const start = yield* Effect.sync(() => Date.now());
          const vm = yield* runMicrovm({
            idlePolicy: {
              maxIdleDurationSeconds: 900,
              suspendedDurationSeconds: 300,
              autoResumeEnabled: true,
            },
          });
          return yield* Effect.gen(function* () {
            // Wait until the MicroVM is RUNNING.
            yield* getMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
              Effect.flatMap((m) =>
                m.state === "RUNNING"
                  ? Effect.void
                  : Effect.fail(new Error(`microvm ${m.state}`)),
              ),
              Effect.retry({
                schedule: Schedule.spaced("1 second"),
                times: 60,
              }),
              Effect.orDie,
            );
            // Reachable when the in-VM RPC answers.
            const { authToken } = yield* createAuthToken({
              microvmIdentifier: vm.microvmId,
              expirationInMinutes: 5,
              allowedPorts: [{ port: 8080 }],
            });
            const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {
              endpoint: vm.endpoint,
              authToken,
            });
            yield* sandbox.hello("bench").pipe(
              Effect.retry({
                schedule: Schedule.exponential("250 millis"),
                times: 10,
              }),
              Effect.orDie,
            );
            const ms = (yield* Effect.sync(() => Date.now())) - start;
            return yield* HttpServerResponse.json({ ms });
          }).pipe(
            // Always terminate — a leaked MicroVM consumes the account's memory
            // quota and would starve later boots in the same run.
            Effect.ensuring(
              terminateMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
                Effect.ignore,
              ),
            ),
            Effect.provide(FetchHttpClient.layer),
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
) {}
