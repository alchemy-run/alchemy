import * as s3 from "@distilled.cloud/aws/s3";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Resolve.ts";
import type { StateStoreLifecycle, StateStoreTarget } from "../../Plugin.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { deleteAllObjects } from "../Bootstrap.ts";
import { AWSEnvironment } from "../Environment.ts";
import {
  createStateBucketName,
  provisionStateBucket,
  stateBucketExists,
  stateEnvironment,
} from "../StateStore/State.ts";

/**
 * Ensure the state bucket (by default the one for the environment's account
 * and region) with the settings first use would give it.
 */
const bootstrapStateBucket = Effect.fn("AWS.state.bootstrap")(function* (name?: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  const bucketName = name ?? createStateBucketName(accountId, region);
  const existed = yield* stateBucketExists(bucketName);
  yield* provisionStateBucket(bucketName, region);
  return { accountId, region, bucketName, existed };
});

/**
 * Empty and delete the state bucket (by default the one for the environment's
 * account and region), every object version included. A missing bucket is not
 * an error.
 */
const teardownStateBucket = Effect.fn("AWS.state.teardown")(function* (name?: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  const bucketName = name ?? createStateBucketName(accountId, region);
  if (!(yield* stateBucketExists(bucketName))) {
    return { accountId, region, bucketName, deleted: false };
  }
  yield* deleteAllObjects(bucketName);
  yield* s3.deleteBucket({ Bucket: bucketName }).pipe(
    Effect.catchTag("NoSuchBucket", () => Effect.void),
    Effect.retry({
      while: (error) => error._tag === "OperationAborted" || error._tag === "ServiceUnavailable",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
  );
  return { accountId, region, bucketName, deleted: true };
});

/** The AWS environment of the target's alchemy profile. */
const environment = Effect.fn(function* (target: StateStoreTarget) {
  const config = ConfigProvider.layer(
    withProfileOverride(
      yield* loadConfigProvider(Option.fromNullishOr(target.envFile)),
      target.profile,
    ),
  );
  // Fresh: AWS auth registers into this registry even when the process
  // already built the provider's layers for another one.
  return Layer.fresh(
    stateEnvironment().pipe(
      Layer.provide(Layer.succeed(AuthProviders, {} satisfies AuthProviders["Service"])),
      Layer.provide(config),
    ),
  );
});

/**
 * The S3 state store's lifecycle, for `Alchemist.State` and `alchemy state`.
 * The store also creates its bucket on first use, so bootstrapping is only
 * needed to provision it ahead of time. S3 keeps no log stream to show.
 */
export const lifecycle: StateStoreLifecycle = {
  bootstrap: (input) =>
    Effect.gen(function* () {
      const { bucketName, accountId, region, existed } = yield* bootstrapStateBucket(
        input.name,
      ).pipe(Effect.provide(yield* environment(input)));
      const status = existed ? ("adopted" as const) : ("created" as const);
      return {
        status,
        summary: `State bucket '${bucketName}' ${status} in account ${accountId} (${region}).`,
      };
    }),
  teardown: (input) =>
    Effect.gen(function* () {
      const { bucketName, deleted } = yield* teardownStateBucket(input.name).pipe(
        Effect.provide(yield* environment(input)),
      );
      return { deleted: deleted ? [bucketName] : [] };
    }),
};
