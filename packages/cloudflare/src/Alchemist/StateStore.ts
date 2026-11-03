import * as workers from "@distilled.cloud/cloudflare/workers";
import { currentProfileName } from "alchemy/Auth/Profile";
import type {
  StateStoreImpl,
  StateStoreLifecycle,
  StateStoreLogEntry,
} from "alchemy/Contributions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as CloudflareAccess from "../Access.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import * as CloudflareCredentials from "../Credentials.ts";
import { CloudflareLogs } from "../Logs.ts";
import { STATE_STORE_SCRIPT_NAME } from "../StateStore/Api.ts";
import { validateStateStoreWorkerName } from "../StateStore/Deploy.ts";
import {
  bootstrap as bootstrapStateStore,
  state,
  teardownStateStore,
} from "../StateStore/State.ts";

/**
 * The profile, Cloudflare account and clients a store's lifecycle operation
 * runs with, under the profile config and auth registry core provides.
 */
export const stateStoreScope = Effect.fn(function* (name: string | undefined) {
  // `--name` is the store's full Worker name.
  const workerName = yield* validateStateStoreWorkerName(name ?? STATE_STORE_SCRIPT_NAME);
  const layer = Layer.mergeAll(
    CloudflareCredentials.fromAuthProvider(),
    CloudflareEnvironment.fromProfile(),
    CloudflareAccess.AccessLive,
  );
  const { accountId } = yield* Effect.flatten(CloudflareEnvironment.CloudflareEnvironment).pipe(
    Effect.provide(layer),
  );
  return {
    layer,
    profile: yield* currentProfileName,
    accountId,
    workerName,
  };
});

const logEntry = (line: {
  readonly timestamp: Date;
  readonly message: string;
}): StateStoreLogEntry => ({ timestamp: line.timestamp, message: line.message });

/** The state-store Worker's lifecycle, for `Alchemist.State` and `alchemy state`. */
export const lifecycle: StateStoreLifecycle = {
  bootstrap: ({ options, force }) =>
    Effect.gen(function* () {
      const { layer, accountId, workerName, profile } = yield* stateStoreScope(options?.name);
      return yield* Effect.gen(function* () {
        const existed = yield* workers.getScriptSetting({ accountId, scriptName: workerName }).pipe(
          Effect.as(true),
          Effect.catchTag(["WorkerNotFound", "InvalidRoute", "WorkerHasNoVersions"], () =>
            Effect.succeed(false),
          ),
        );
        const store = yield* bootstrapStateStore({
          workerName,
          domain: options?.domain,
          force,
          profile,
        });
        return {
          status: !existed
            ? ("created" as const)
            : force
              ? ("redeployed" as const)
              : ("adopted" as const),
          store: workerName,
          location: { account: accountId, version: String(yield* store.getVersion()) },
        };
      }).pipe(Effect.provide(layer));
    }),
  teardown: ({ options }) =>
    Effect.gen(function* () {
      const { layer, workerName, profile } = yield* stateStoreScope(options?.name);
      yield* Effect.provide(teardownStateStore({ workerName, profile }), layer);
      return { deleted: [workerName] };
    }),
  logs: ({ options, limit, since }) =>
    Effect.gen(function* () {
      const { layer, accountId, workerName } = yield* stateStoreScope(options?.name);
      const lines = yield* Effect.gen(function* () {
        const telemetry = yield* CloudflareLogs;
        return yield* telemetry.queryLogs({
          accountId,
          filters: [
            { key: "$workers.scriptName", operation: "eq", type: "string", value: workerName },
          ],
          options: { limit: limit ?? 100, since },
        });
      }).pipe(Effect.provide(layer));
      return lines.map(logEntry).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }),
  tailLogs: ({ options }) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { layer, accountId, workerName } = yield* stateStoreScope(options?.name);
        const telemetry = yield* Effect.provide(CloudflareLogs, layer);
        return telemetry
          .tailScript({ accountId, scriptName: workerName })
          .pipe(Stream.provide(layer), Stream.map(logEntry));
      }),
    ),
};

/** The state store Cloudflare contributes. */
export const stateStore: StateStoreImpl = {
  // `--name` is the store's full Worker name; `--domain` the hostname it is
  // served on, as `Cloudflare.state({ domain })` configures it.
  layer: (options) => state({ workerName: options?.name, domain: options?.domain }),
  lifecycle,
};
