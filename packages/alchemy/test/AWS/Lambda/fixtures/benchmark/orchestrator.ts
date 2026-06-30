import * as AWS from "@/AWS";
import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BenchExternal } from "./external-image.ts";
import { Sandbox } from "../microvm/sandbox.ts";

/**
 * Cold-start benchmark orchestrator (the AWS analog of the Cloudflare Container
 * benchmark's Durable Object). It exposes a `boot`/`shutdown` lifecycle so the
 * benchmark can drive — and time — each cold start from the OUTSIDE:
 *
 * - `GET /boot?variant=effectful|external&key=K` launches ONE fresh MicroVM and
 *   blocks until it is reachable, returning `{ id, bootMs, readyMs }` where
 *   `bootMs` = `RunMicrovm` → `RUNNING` (provisioned) and `readyMs` =
 *   `RunMicrovm` → in-VM service answers (available). It does NOT terminate.
 * - `GET /shutdown?variant=…&id=ID` terminates the MicroVM.
 *
 * The benchmark loops boot→shutdown with a fresh `key` each iteration to watch
 * how cold start trends over successive boots of the same image.
 */
type Variant = {
  readonly run: (
    req: AWS.Lambda.RunMicrovmRequest,
  ) => Effect.Effect<microvms.RunMicrovmResponse, microvms.RunMicrovmError>;
  readonly get: (
    req: AWS.Lambda.GetMicrovmRequest,
  ) => Effect.Effect<microvms.GetMicrovmResponse, microvms.GetMicrovmError>;
  readonly auth: (
    req: AWS.Lambda.CreateAuthTokenRequest,
  ) => Effect.Effect<
    microvms.CreateMicrovmAuthTokenResponse,
    microvms.CreateMicrovmAuthTokenError
  >;
  readonly term: (
    req: AWS.Lambda.TerminateMicrovmRequest,
  ) => Effect.Effect<
    microvms.TerminateMicrovmResponse,
    microvms.TerminateMicrovmError
  >;
  readonly reachable: (
    endpoint: string,
    authToken: AWS.Lambda.MicrovmConnection["authToken"],
  ) => Effect.Effect<
    unknown,
    HttpClientError.HttpClientError,
    HttpClient.HttpClient
  >;
};

export default class BenchOrchestrator extends AWS.Lambda.Function<BenchOrchestrator>()(
  "MicrovmBenchOrchestrator",
  {
    main: import.meta.filename,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    const effectful: Variant = {
      run: yield* AWS.Lambda.RunMicrovm(Sandbox),
      get: yield* AWS.Lambda.GetMicrovm(Sandbox),
      auth: yield* AWS.Lambda.CreateAuthToken(Sandbox),
      term: yield* AWS.Lambda.TerminateMicrovm(Sandbox),
      reachable: (endpoint, authToken) =>
        Effect.gen(function* () {
          const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {
            endpoint,
            authToken,
          });
          return yield* sandbox.hello("bench");
        }),
    };
    const external: Variant = {
      run: yield* AWS.Lambda.RunMicrovm(BenchExternal),
      get: yield* AWS.Lambda.GetMicrovm(BenchExternal),
      auth: yield* AWS.Lambda.CreateAuthToken(BenchExternal),
      term: yield* AWS.Lambda.TerminateMicrovm(BenchExternal),
      reachable: (endpoint, authToken) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.get(`https://${endpoint}/`, {
            headers: AWS.Lambda.microvmAuthHeaders(authToken),
          });
          return yield* res.text;
        }),
    };
    const pick = (v: string | null): Variant =>
      v === "external" ? external : effectful;

    // Run one fresh MicroVM and time RunMicrovm → RUNNING (bootMs) and
    // RunMicrovm → service-reachable (readyMs). Leaves it running for an
    // explicit /shutdown; self-terminates only if boot itself fails.
    const boot = (v: Variant) =>
      Effect.gen(function* () {
        const start = yield* Effect.sync(() => Date.now());
        const vm = yield* v.run({
          idlePolicy: {
            maxIdleDurationSeconds: 900,
            suspendedDurationSeconds: 300,
            autoResumeEnabled: true,
          },
        });
        return yield* Effect.gen(function* () {
          yield* v.get({ microvmIdentifier: vm.microvmId }).pipe(
            Effect.flatMap((m) =>
              m.state === "RUNNING"
                ? Effect.void
                : Effect.fail(new Error(`microvm ${m.state}`)),
            ),
            Effect.retry({
              schedule: Schedule.spaced("500 millis"),
              times: 180,
            }),
          );
          const bootMs = (yield* Effect.sync(() => Date.now())) - start;
          const { authToken } = yield* v.auth({
            microvmIdentifier: vm.microvmId,
            expirationInMinutes: 5,
            allowedPorts: [{ port: 8080 }],
          });
          yield* v.reachable(vm.endpoint, authToken).pipe(
            Effect.retry({
              schedule: Schedule.exponential("250 millis"),
              times: 14,
            }),
          );
          const readyMs = (yield* Effect.sync(() => Date.now())) - start;
          return yield* HttpServerResponse.json({
            id: vm.microvmId,
            bootMs,
            readyMs,
          });
        }).pipe(
          // Only clean up if boot FAILED — a successful boot is torn down by the
          // explicit /shutdown call so the benchmark can time it separately.
          Effect.onError(() =>
            v.term({ microvmIdentifier: vm.microvmId }).pipe(Effect.ignore),
          ),
          Effect.provide(FetchHttpClient.layer),
        );
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const v = pick(url.searchParams.get("variant"));

        if (request.method === "GET" && url.pathname === "/boot") {
          return yield* boot(v);
        }
        if (request.method === "GET" && url.pathname === "/shutdown") {
          const id = url.searchParams.get("id")!;
          yield* v.term({ microvmIdentifier: id }).pipe(Effect.ignore);
          return yield* HttpServerResponse.json({ ok: true });
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
