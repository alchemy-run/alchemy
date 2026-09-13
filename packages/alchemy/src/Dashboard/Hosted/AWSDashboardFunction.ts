import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { AWSEnvironment } from "../../AWS/Environment.ts";
import { Function, isBindingHost } from "../../AWS/Lambda/Function.ts";
import { makeS3State } from "../../AWS/StateStore/State.ts";
import * as Binding from "../../Binding.ts";
import { viewer } from "../Viewer.ts";

/**
 * The Lambda behind `Dashboard.Hosted.AWS`: the read-only dashboard viewer
 * API (`alchemy/Dashboard/Viewer`) over the S3 state store, behind a
 * Function URL.
 *
 * Unlike the Cloudflare state store (an HTTP API Worker), the AWS store has
 * no server — this function IS the reader: its execution role gets
 * `s3:ListBucket` / `s3:GetObject` on the state bucket plus `kms:Decrypt`
 * for the store's envelope-encrypted secrets, so no long-lived credentials
 * exist anywhere.
 *
 * This module is the function's bundle entry (`main: import.meta.url`).
 * The bucket to read is decided by the stack-side factory (`Hosted/AWS.ts`)
 * and reaches this class through the ambient `ConfigProvider` — the
 * `Config` reads below, which the deploy-time interceptor lowers into
 * environment variables and which resolve from the environment at runtime.
 *
 * Users never import this file directly; `Dashboard.Hosted.AWS` yields it.
 */

/** `Config` keys the function reads (bound into its env at deploy time). */
export const STATE_BUCKET_KEY = "ALCHEMY_STATE_BUCKET";
export const STATE_PREFIX_KEY = "ALCHEMY_STATE_PREFIX";
export const STATE_ACCOUNT_ID_KEY = "ALCHEMY_STATE_ACCOUNT_ID";
export const DASHBOARD_STACK_KEY = "ALCHEMY_DASHBOARD_STACK";
export const DASHBOARD_STAGE_KEY = "ALCHEMY_DASHBOARD_STAGE";

/**
 * The runtime's `AWSEnvironment`: the Lambda bootstrap provides
 * `Credentials` (the execution role) and `Region` (`AWS_REGION`), which is
 * all the state store needs; the account id only feeds the default bucket
 * name, and the factory always pins the bucket explicitly.
 */
const runtimeEnvironment = (accountId: string) =>
  Layer.effect(
    AWSEnvironment,
    Effect.gen(function* () {
      const credentials = yield* Credentials.Credentials;
      const region = yield* yield* Region.Region;
      return Effect.succeed({ accountId, region, credentials });
    }),
  );

export default class AWSDashboard extends Function<AWSDashboard>()(
  "AlchemyDashboard",
  {
    main: import.meta.url,
    functionUrl: true,
    memorySize: 512,
  },
  Effect.gen(function* () {
    // Deploy time: the factory's ConfigProvider overlay answers these and
    // the Config interceptor lowers each read into an environment
    // variable. Runtime: the same reads resolve from the environment.
    const bucketName = yield* Config.string(STATE_BUCKET_KEY);
    const prefix = yield* Config.string(STATE_PREFIX_KEY).pipe(
      Config.withDefault(""),
    );
    const accountId = yield* Config.string(STATE_ACCOUNT_ID_KEY).pipe(
      Config.withDefault(""),
    );
    const stack = yield* Config.string(DASHBOARD_STACK_KEY).pipe(
      Config.withDefault(""),
    );
    const stage = yield* Config.string(DASHBOARD_STAGE_KEY).pipe(
      Config.withDefault(""),
    );

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isBindingHost(host)) {
        const bucketArn = `arn:aws:s3:::${bucketName}`;
        yield* host.bind`Allow(${host}, AlchemyDashboardStateRead)`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: [bucketArn],
            },
            {
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/*`],
            },
            // The store's secrets are wrapped by the auto-managed
            // `alias/alchemy-state` KMS key. Decrypt cannot be scoped by
            // alias (the ciphertext names the key, the request never
            // does); pin the key ARN here if your account policy
            // requires it.
            {
              Effect: "Allow",
              Action: ["kms:Decrypt"],
              Resource: ["*"],
            },
          ],
        });
      }
    }

    // The state client is built lazily on the first request and kept for
    // the sandbox's lifetime: it holds no disposable resource, and the
    // bucket check it performs on first use is memoized inside it.
    let handler:
      | Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          never,
          HttpServerRequest
        >
      | undefined;
    const makeHandler = Effect.gen(function* () {
      const state = yield* makeS3State({
        bucketName,
        ...(prefix !== "" ? { prefix } : {}),
      }).pipe(Effect.provide(runtimeEnvironment(accountId)));
      return viewer({
        state,
        stack: stack === "" ? undefined : stack,
        stage: stage === "" ? undefined : stage,
        // Lambda Function URLs buffer responses (BUFFERED invoke mode) — an
        // unending SSE stream would never flush. `poll` closes after each
        // snapshot and lets EventSource's auto-reconnect poll.
        sse: "poll",
        diagnostics: { store: "s3", bucket: bucketName },
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ) as Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        HttpServerRequest
      >;
    });

    return {
      fetch: Effect.gen(function* () {
        if (handler === undefined) {
          handler = yield* makeHandler;
        }
        return yield* handler;
      }),
    };
  }),
) {}
