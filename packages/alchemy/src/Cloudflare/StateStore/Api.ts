import { Redacted } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import crypto from "node:crypto";
import { RuntimeContext } from "../../RuntimeContext.ts";
import {
  BearerTokenValidator,
  StateApi,
  StateAuthLive,
  type DeploymentCorruptWire,
  type DeploymentEventWire,
  type DeploymentInProgressWire,
  type DeploymentNotFoundWire,
  type DeploymentTokenInvalidWire,
  type StateWriteFencedWire,
} from "../../State/HttpStateApi.ts";
import { ReadSecret } from "../SecretsStore/ReadSecret.ts";
import { ReadSecretBinding } from "../SecretsStore/ReadSecretBinding.ts";
import { Worker } from "../Workers/Worker.ts";
import Store from "./Store.ts";
import { AuthToken } from "./Token.ts";

export const STATE_STORE_SCRIPT_NAME = "alchemy-state-store" as const;

/**
 * Version of the deployed Cloudflare State Store worker contract.
 *
 * Bump this whenever the wire format or runtime behaviour of the
 * worker changes in a way that an older deployed copy can no longer
 * satisfy. Clients query `/version` on the deployed worker and
 * compare against this constant; a mismatch (or 404) triggers a
 * forced redeploy via the bootstrap flow.
 */
export const STATE_STORE_VERSION = 10 as const;

/**
 * Hard-coded OTLP/HTTP endpoints. Point at the public ingest relay
 * defined in `stacks/otel.ts` (bound to `otel.alchemy.run`), which
 * forwards to Axiom with the bearer token attached server-side. Hard-
 * coded on purpose: the worker has no env-var plumbing and the relay
 * is account-level infra that lives outside any single deploy.
 */
// const OTEL_TRACES_URL = "https://otel.alchemy.run/v1/traces";
// const OTEL_METRICS_URL = "https://otel.alchemy.run/v1/metrics";
// const OTEL_LOGS_URL = "https://otel.alchemy.run/v1/logs";

/**
 * OTLP traces + metrics + logs Layer for the state-store worker.
 * Mirrors the CLI's `TelemetryLive` so every signal the worker emits
 * (`Effect.withSpan`, runtime metrics, `Effect.log*`) ships to the
 * same Axiom datasets as deploy-time CLI signals. Resource attributes
 * brand each signal with the worker's service name + contract version
 * so they're easy to slice in Axiom.
 */
// const otelResource = {
//   serviceName: STATE_STORE_SCRIPT_NAME,
//   serviceVersion: String(STATE_STORE_VERSION),
//   attributes: {
//     "alchemy.state_store.script_name": STATE_STORE_SCRIPT_NAME,
//     "alchemy.state_store.version": STATE_STORE_VERSION,
//   },
// } as const;

// const TelemetryLive = Layer.mergeAll(
//   OtlpTracer.layer({
//     url: OTEL_TRACES_URL,
//     resource: otelResource,
//     exportInterval: "1 second",
//   }),
//   OtlpMetrics.layer({
//     url: OTEL_METRICS_URL,
//     resource: otelResource,
//     exportInterval: "1 second",
//   }),
//   // Replace (don't merge with) the default stdout logger so worker logs
//   // ship to Axiom instead of just `wrangler tail`.
//   OtlpLogger.layer({
//     url: OTEL_LOGS_URL,
//     resource: otelResource,
//     exportInterval: "1 second",
//     mergeWithExisting: false,
//   }),
// ).pipe(
//   Layer.provide(OtlpSerialization.layerJson),
//   Layer.provide(FetchHttpClient.layer),
// );

/**
 * Path on disk to *this* file, used as the worker's bundling entry.
 *
 * When running from source (e.g. dev / monorepo), `import.meta.url` points
 * at `Api.ts` and we can use it directly. When the alchemy CLI is run from
 * its published `bin/alchemy.js` bundle, this module is inlined into the
 * CLI bundle and `import.meta.url` resolves to `bin/alchemy.js` — which
 * has no `default` export and breaks the worker bundler with
 * `[MISSING_EXPORT] "default" is not exported by "bin/alchemy.js"`.
 *
 * In the bundled case, fall back to the published source file shipped
 * alongside the CLI under `../src/Cloudflare/StateStore/Api.ts`.
 */
export default Worker(
  "Api",
  {
    name: STATE_STORE_SCRIPT_NAME,
    main: import.meta.url,
    workersDev: true,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const remoteSecret = yield* ReadSecret(AuthToken);
    const store = yield* Store;

    const bearerTokenValidator = Layer.succeed(
      BearerTokenValidator,
      BearerTokenValidator.of({
        validate: Effect.fn(function* (token) {
          const expected = yield* remoteSecret
            .get()
            .pipe(Effect.orDie, Effect.provide(RuntimeContext.phantom));
          return !!expected &&
            timingSafeEqual(token.trim(), Redacted.value(expected).trim())
            ? yield* Effect.void
            : yield* new HttpApiError.Unauthorized();
        }),
      }),
    );

    const versionApi = HttpApiBuilder.group(StateApi, "version", (handlers) =>
      handlers.handle("getVersion", () =>
        Effect.succeed({ version: STATE_STORE_VERSION }).pipe(
          Effect.withSpan("state_store.getVersion", {
            attributes: { "alchemy.state_store.op": "getVersion" },
          }),
        ),
      ),
    );

    const stateApi = HttpApiBuilder.group(StateApi, "state", (handlers) =>
      handlers
        .handle("listStacks", () =>
          store
            .getByName(Store.ROOT_DO_NAME)
            .listStacks()
            .pipe(
              Effect.withSpan("state_store.listStacks", {
                attributes: { "alchemy.state_store.op": "listStacks" },
              }),
            ),
        )
        .handle("listStages", ({ params }) =>
          store
            .getByName(params.stack)
            .listStages()
            .pipe(
              Effect.withSpan("state_store.listStages", {
                attributes: {
                  "alchemy.state_store.op": "listStages",
                  "alchemy.state_store.stack": params.stack,
                },
              }),
            ),
        )
        .handle("listResources", ({ params }) =>
          store
            .getByName(params.stack)
            .listResources({ stage: params.stage })
            .pipe(
              Effect.withSpan("state_store.listResources", {
                attributes: {
                  "alchemy.state_store.op": "listResources",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("getState", ({ params }) => {
          const fqn = decodeURIComponent(params.fqn);
          return store
            .getByName(params.stack)
            .get({ stage: params.stage, fqn })
            .pipe(
              Effect.withSpan("state_store.getState", {
                attributes: {
                  "alchemy.state_store.op": "getState",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            );
        })
        .handle("setState", ({ params, payload, query }) => {
          const fqn = decodeURIComponent(params.fqn);
          return store
            .getByName(params.stack)
            .set({
              stage: params.stage,
              fqn,
              value: payload as any,
              fence: query.fence,
            })
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "ok"
                  ? Effect.succeed(result.value)
                  : failStateWriteFenced(params, query.fence!),
              ),
              Effect.tap(() =>
                store
                  .getByName(Store.ROOT_DO_NAME)
                  .registerStack({ stack: params.stack }),
              ),
              Effect.withSpan("state_store.setState", {
                attributes: {
                  "alchemy.state_store.op": "setState",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            );
        })
        .handle("deleteState", ({ params, query }) => {
          const fqn = decodeURIComponent(params.fqn);
          // The DO method is `remove`, not `delete` — `delete` is
          // reserved by Cloudflare's RPC stub proxy.
          return store
            .getByName(params.stack)
            .remove({ stage: params.stage, fqn, fence: query.fence })
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "ok"
                  ? Effect.void
                  : failStateWriteFenced(params, query.fence!),
              ),
              Effect.withSpan("state_store.deleteState", {
                attributes: {
                  "alchemy.state_store.op": "deleteState",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.fqn": fqn,
                },
              }),
            );
        })
        .handle("getReplacedResources", ({ params }) =>
          store
            .getByName(params.stack)
            .getReplacedResources({ stage: params.stage })
            .pipe(
              Effect.withSpan("state_store.getReplacedResources", {
                attributes: {
                  "alchemy.state_store.op": "getReplacedResources",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("getStackOutput", ({ params }) =>
          store
            .getByName(params.stack)
            .getOutput({ stage: params.stage })
            .pipe(
              Effect.withSpan("state_store.getStackOutput", {
                attributes: {
                  "alchemy.state_store.op": "getStackOutput",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("setStackOutput", ({ params, payload, query }) =>
          store
            .getByName(params.stack)
            .setOutput({
              stage: params.stage,
              value: payload as any,
              fence: query.fence,
            })
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "ok"
                  ? Effect.succeed(result.value)
                  : failStateWriteFenced(params, query.fence!),
              ),
              Effect.tap(() =>
                store
                  .getByName(Store.ROOT_DO_NAME)
                  .registerStack({ stack: params.stack }),
              ),
              Effect.withSpan("state_store.setStackOutput", {
                attributes: {
                  "alchemy.state_store.op": "setStackOutput",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("getAllStates", ({ params }) =>
          store
            .getByName(params.stack)
            .getAll({ stage: params.stage })
            .pipe(
              Effect.withSpan("state_store.getAllStates", {
                attributes: {
                  "alchemy.state_store.op": "getAllStates",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("beginDeployment", ({ params, payload }) =>
          store
            .getByName(params.stack)
            .deploymentBegin({
              stack: params.stack,
              stage: params.stage,
              meta: payload.meta,
              ttlMillis: payload.ttlMillis,
              supersede: payload.supersede,
            })
            .pipe(
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  { version: number; token: string },
                  | typeof DeploymentInProgressWire.Type
                  | typeof DeploymentCorruptWire.Type
                > =>
                  result._tag === "ok"
                    ? Effect.succeed({
                        version: result.version,
                        token: result.token,
                      })
                    : result._tag === "in-progress"
                      ? Effect.fail({
                          _tag: "DeploymentInProgress",
                          stack: params.stack,
                          stage: params.stage,
                          holder: result.holder,
                        } as const)
                      : Effect.fail({
                          _tag: "DeploymentCorrupt",
                          message: result.message,
                        } as const),
              ),
              Effect.withSpan("state_store.beginDeployment", {
                attributes: {
                  "alchemy.state_store.op": "beginDeployment",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("appendDeploymentEvents", ({ params, payload }) =>
          store
            .getByName(params.stack)
            .deploymentAppendEvents({
              stage: params.stage,
              version: params.version,
              token: payload.token,
              events: payload.events,
            })
            .pipe(
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  { ackedSeq: number },
                  | typeof DeploymentTokenInvalidWire.Type
                  | typeof DeploymentNotFoundWire.Type
                > =>
                  result._tag === "ok"
                    ? Effect.succeed({ ackedSeq: result.ackedSeq })
                    : failDeploymentMutation(result._tag, params),
              ),
              Effect.withSpan("state_store.appendDeploymentEvents", {
                attributes: {
                  "alchemy.state_store.op": "appendDeploymentEvents",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.deployment_version": params.version,
                },
              }),
            ),
        )
        .handle("heartbeatDeployment", ({ params, payload }) =>
          store
            .getByName(params.stack)
            .deploymentHeartbeat({
              stage: params.stage,
              version: params.version,
              token: payload.token,
            })
            .pipe(
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  | typeof DeploymentTokenInvalidWire.Type
                  | typeof DeploymentNotFoundWire.Type
                > =>
                  result._tag === "ok"
                    ? Effect.void
                    : failDeploymentMutation(result._tag, params),
              ),
              Effect.withSpan("state_store.heartbeatDeployment", {
                attributes: {
                  "alchemy.state_store.op": "heartbeatDeployment",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.deployment_version": params.version,
                },
              }),
            ),
        )
        .handle("endDeployment", ({ params, payload }) =>
          store
            .getByName(params.stack)
            .deploymentEnd({
              stage: params.stage,
              version: params.version,
              token: payload.token,
              outcome: payload.outcome,
              summary: payload.summary,
            })
            .pipe(
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  | typeof DeploymentTokenInvalidWire.Type
                  | typeof DeploymentNotFoundWire.Type
                > =>
                  result._tag === "ok"
                    ? Effect.void
                    : failDeploymentMutation(result._tag, params),
              ),
              Effect.withSpan("state_store.endDeployment", {
                attributes: {
                  "alchemy.state_store.op": "endDeployment",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.deployment_version": params.version,
                },
              }),
            ),
        )
        .handle("listDeployments", ({ params, query }) =>
          store
            .getByName(params.stack)
            .deploymentList({
              stage: params.stage,
              before: query.before,
              limit: query.limit,
            })
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "ok"
                  ? Effect.succeed(result.records)
                  : Effect.fail({
                      _tag: "DeploymentCorrupt",
                      message: result.message,
                    } as const),
              ),
              Effect.withSpan("state_store.listDeployments", {
                attributes: {
                  "alchemy.state_store.op": "listDeployments",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                },
              }),
            ),
        )
        .handle("getDeployment", ({ params }) =>
          store
            .getByName(params.stack)
            .deploymentGet({
              stage: params.stage,
              version: params.version,
            })
            .pipe(
              Effect.flatMap((result) =>
                result._tag === "ok"
                  ? Effect.succeed(result.record)
                  : Effect.fail({
                      _tag: "DeploymentCorrupt",
                      message: result.message,
                    } as const),
              ),
              Effect.withSpan("state_store.getDeployment", {
                attributes: {
                  "alchemy.state_store.op": "getDeployment",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.deployment_version": params.version,
                },
              }),
            ),
        )
        .handle("readDeploymentEvents", ({ params, query }) =>
          store
            .getByName(params.stack)
            .deploymentReadEvents({
              stage: params.stage,
              version: params.version,
              fromSeq: query.fromSeq,
            })
            .pipe(
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  readonly (typeof DeploymentEventWire.Type)[],
                  | typeof DeploymentNotFoundWire.Type
                  | typeof DeploymentCorruptWire.Type
                > =>
                  result._tag === "ok"
                    ? Effect.succeed(result.events)
                    : result._tag === "not-found"
                      ? Effect.fail({
                          _tag: "DeploymentNotFound",
                          stack: params.stack,
                          stage: params.stage,
                          version: params.version,
                        } as const)
                      : Effect.fail({
                          _tag: "DeploymentCorrupt",
                          message: result.message,
                        } as const),
              ),
              Effect.withSpan("state_store.readDeploymentEvents", {
                attributes: {
                  "alchemy.state_store.op": "readDeploymentEvents",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": params.stage,
                  "alchemy.state_store.deployment_version": params.version,
                },
              }),
            ),
        )
        .handle("deleteStack", ({ params, query }) =>
          store
            .getByName(params.stack)
            .deleteStack(
              query.stage === undefined ? {} : { stage: query.stage },
            )
            .pipe(
              Effect.flatMap(() =>
                query.stage === undefined
                  ? store
                      .getByName(Store.ROOT_DO_NAME)
                      .unregisterStack({ stack: params.stack })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.withSpan("state_store.deleteStack", {
                attributes: {
                  "alchemy.state_store.op": "deleteStack",
                  "alchemy.state_store.stack": params.stack,
                  "alchemy.state_store.stage": query.stage ?? "",
                  "alchemy.state_store.scope":
                    query.stage === undefined ? "stack" : "stage",
                },
              }),
            ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(StateApi).pipe(
        Layer.provide(stateApi),
        Layer.provide(versionApi),
        Layer.provide(StateAuthLive),
        Layer.provide(bearerTokenValidator),
        // The state-store worker never serves files, so HttpPlatform's
        // file-response surface is stubbed.
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
        // Effect.provide(TelemetryLive),
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(ReadSecretBinding))),
);

/**
 * Map the stack DO's fenced-write refusal onto the schema-typed 412
 * wire error. Like the deployment mutations, the DO surfaces the
 * refusal as a discriminated result value (its RPC stub serializes
 * thrown errors lossily); the worker is where it becomes typed HTTP.
 */
const failStateWriteFenced = (
  params: { stack: string; stage: string },
  fence: number,
): Effect.Effect<never, typeof StateWriteFencedWire.Type> =>
  Effect.fail({
    _tag: "StateWriteFenced",
    stack: params.stack,
    stage: params.stage,
    fence,
  } as const);

/**
 * Map the stack DO's deployment mutation failures onto the schema-typed
 * wire errors declared in `HttpStateApi.ts`. The DO returns discriminated
 * result values (its RPC stub serializes thrown errors lossily); the worker
 * is where they become typed HTTP failures.
 */
const failDeploymentMutation = (
  tag: "not-found" | "invalid-token",
  params: { stack: string; stage: string; version: number },
): Effect.Effect<
  never,
  typeof DeploymentNotFoundWire.Type | typeof DeploymentTokenInvalidWire.Type
> =>
  tag === "not-found"
    ? Effect.fail({
        _tag: "DeploymentNotFound",
        stack: params.stack,
        stage: params.stage,
        version: params.version,
      } as const)
    : Effect.fail({
        _tag: "DeploymentTokenInvalid",
        stack: params.stack,
        stage: params.stage,
        version: params.version,
      } as const);

/**
 * Stub `HttpPlatform` for the worker. The state-store API never
 * issues file responses, so both surface methods die if invoked. Lets
 * us avoid pulling in a `FileSystem` dependency that workers don't
 * have.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

/**
 * Timing-safe string comparison using the Workers runtime's built-in
 * `crypto.subtle.timingSafeEqual`.
 *
 * @see https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  // @ts-expect-error - TODO(sam)
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
};
