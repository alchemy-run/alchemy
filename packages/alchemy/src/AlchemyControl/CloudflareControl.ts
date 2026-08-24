import * as workers from "@distilled.cloud/cloudflare/workers";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { withProfileOverride } from "../Auth/Profile.ts";
import * as CloudflareAccess from "../Cloudflare/Access.ts";
import { CloudflareAuth } from "../Cloudflare/Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "../Cloudflare/CloudflareEnvironment.ts";
import * as CloudflareCredentials from "../Cloudflare/Credentials.ts";
import { CloudflareLogs } from "../Cloudflare/Logs.ts";
import { STATE_STORE_SCRIPT_NAME } from "../Cloudflare/StateStore/Api.ts";
import {
  bootstrap,
  teardownStateStore,
} from "../Cloudflare/StateStore/State.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";
import { fileLogger } from "../Util/FileLogger.ts";
import type { ControlContext } from "./ControlContext.ts";
import { internalize } from "./ControlEffect.ts";
import {
  ControlInternalError,
  type ControlError,
  type CloudflareBootstrapInput,
  type CloudflareStateLogsInput,
  type CloudflareStateTarget,
  type LogEntry,
} from "./Surface.ts";

export const makeCloudflareControl = Effect.gen(function* () {
  const context = yield* Effect.context<ControlContext>();

  const services = Effect.fn(function* (target: CloudflareStateTarget) {
    const registry: AuthProviders["Service"] = {};
    const auth = Layer.provideMerge(
      CloudflareAuth,
      Layer.succeed(AuthProviders, registry),
    );
    const cloudflare = Layer.provideMerge(
      Layer.mergeAll(
        CloudflareCredentials.fromAuthProvider(),
        CloudflareEnvironment.fromProfile(),
        CloudflareAccess.AccessLive,
      ),
      auth,
    );
    return Layer.mergeAll(
      cloudflare,
      ConfigProvider.layer(
        withProfileOverride(
          yield* loadConfigProvider(Option.fromNullishOr(target.envFile)),
          target.profile,
        ),
      ),
      Logger.layer([fileLogger("cloudflare.txt")], { mergeWithExisting: true }),
    );
  });

  const bootstrapState = (input: CloudflareBootstrapInput) =>
    internalize(
      Effect.gen(function* () {
        const layer = yield* services(input);
        return yield* Effect.gen(function* () {
          const environment =
            yield* CloudflareEnvironment.CloudflareEnvironment;
          const { accountId } = yield* environment;
          const workerName = input.workerName ?? STATE_STORE_SCRIPT_NAME;
          const existed = yield* workers
            .getScriptSetting({ accountId, scriptName: workerName })
            .pipe(
              Effect.as(true),
              Effect.catchTag(
                ["WorkerNotFound", "InvalidRoute", "WorkerHasNoVersions"],
                () => Effect.succeed(false),
              ),
            );
          const state = yield* bootstrap({
            workerName,
            force: input.force,
            profile: input.profile,
          });
          return {
            accountId,
            workerName,
            status: !existed
              ? ("created" as const)
              : input.force
                ? ("redeployed" as const)
                : ("adopted" as const),
            credentialsRefreshed: true,
            stateStoreVersion: yield* state.getVersion(),
          };
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(context)),
    );

  const teardown = (input: CloudflareStateTarget) =>
    internalize(
      Effect.gen(function* () {
        const layer = yield* services(input);
        return yield* Effect.gen(function* () {
          const environment =
            yield* CloudflareEnvironment.CloudflareEnvironment;
          const { accountId } = yield* environment;
          const workerName = input.workerName ?? STATE_STORE_SCRIPT_NAME;
          yield* teardownStateStore({ workerName, profile: input.profile });
          return {
            accountId,
            workerName,
            deleted: [workerName],
          };
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(context)),
    );

  const entries = (input: CloudflareStateLogsInput) =>
    internalize(
      Effect.gen(function* () {
        const layer = yield* services(input);
        return yield* Effect.gen(function* () {
          const environment =
            yield* CloudflareEnvironment.CloudflareEnvironment;
          const { accountId } = yield* environment;
          const scriptName = input.workerName ?? STATE_STORE_SCRIPT_NAME;
          const telemetry = yield* CloudflareLogs;
          const lines = yield* telemetry.queryLogs({
            accountId,
            filters: [
              {
                key: "$workers.scriptName",
                operation: "eq",
                type: "string",
                value: scriptName,
              },
            ],
            options: { limit: input.limit ?? 100, since: input.since },
          });
          return lines
            .map((line): LogEntry => ({
              resource: {
                fqn: scriptName,
                logicalId: scriptName,
                resourceType: "Cloudflare.Worker",
              },
              timestamp: line.timestamp,
              message: line.message,
            }))
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(context)),
    );

  const tail = (
    input: CloudflareStateTarget,
  ): Stream.Stream<LogEntry, ControlError> =>
    Stream.unwrap(
      internalize(
        Effect.gen(function* () {
          const layer = yield* services(input);
          const scriptName = input.workerName ?? STATE_STORE_SCRIPT_NAME;
          const data = yield* Effect.gen(function* () {
            const environment =
              yield* CloudflareEnvironment.CloudflareEnvironment;
            const { accountId } = yield* environment;
            return { accountId, telemetry: yield* CloudflareLogs };
          }).pipe(Effect.provide(layer));
          return data.telemetry
            .tailScript({ accountId: data.accountId, scriptName })
            .pipe(
              Stream.provide(layer),
              Stream.provide(context),
              Stream.map((line) => ({
                resource: {
                  fqn: scriptName,
                  logicalId: scriptName,
                  resourceType: "Cloudflare.Worker",
                },
                timestamp: line.timestamp,
                message: line.message,
              })),
              Stream.mapError(
                (cause) =>
                  new ControlInternalError({ message: String(cause), cause }),
              ),
            );
        }).pipe(Effect.provide(context)),
      ),
    );

  return {
    bootstrap: bootstrapState,
    teardown,
    stateLogs: { entries, tail },
  };
});

/** Cloudflare state-store and observability operations. */
export class CloudflareControl extends Context.Service<
  CloudflareControl,
  Effect.Success<typeof makeCloudflareControl>
>()("alchemy/AlchemyControl/Cloudflare") {}

/** Live Cloudflare control implementation. */
export const CloudflareControlLive = Layer.effect(
  CloudflareControl,
  makeCloudflareControl,
);
