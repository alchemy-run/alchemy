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
 * Lambda {@link import("./orchestrator.ts")}. Same `boot`/`shutdown` lifecycle
 * and timings, but driven from a Worker (binding the AWS MicroVM ops provisions
 * an IAM User + AccessKey + assume-role Role once per worker; see
 * `MicrovmBinding.ts`). This measures the Worker → MicroVM cold-start path.
 */
type Variant = {
  readonly run: (
    req: AWS.Lambda.RunMicrovmRequest,
  ) => Effect.Effect<{ microvmId: string; endpoint: string }, any>;
  readonly get: (req: {
    microvmIdentifier: string;
  }) => Effect.Effect<{ state: string }, any>;
  readonly auth: (req: {
    microvmIdentifier: string;
    expirationInMinutes: number;
    allowedPorts: { port: number }[];
  }) => Effect.Effect<
    {
      authToken: Record<string, string | Redacted.Redacted<string> | undefined>;
    },
    any
  >;
  readonly term: (req: {
    microvmIdentifier: string;
  }) => Effect.Effect<unknown, any>;
  readonly reachable: (
    endpoint: string,
    authToken: Record<string, string | Redacted.Redacted<string> | undefined>,
  ) => Effect.Effect<unknown, any, any>;
};

export default Cloudflare.Worker(
  "MicrovmBenchWorker",
  { main: import.meta.filename },
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
          Effect.onError(() =>
            v.term({ microvmIdentifier: vm.microvmId }).pipe(Effect.ignore),
          ),
          Effect.provide(FetchHttpClient.layer),
        );
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm");
        const v = pick(url.searchParams.get("variant"));

        if (url.pathname === "/boot") {
          return yield* boot(v);
        }
        if (url.pathname === "/shutdown") {
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
);
