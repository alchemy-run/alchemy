import * as s3 from "@distilled.cloud/aws/s3";
import type { StateStoreImpl, StateStoreLifecycle } from "alchemy/Contributions";
import * as Provisioning from "alchemy/State/Provisioning";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { deleteAllObjects } from "../Bootstrap.ts";
import { AWSEnvironment } from "../Environment.ts";
import {
  createStateBucketName,
  provisionStateBucket,
  stateBucketExists,
  state,
  stateEnvironment,
} from "../StateStore/State.ts";

/**
 * Ensure a state bucket (by default the account's in this region) with the
 * settings first use would give it.
 */
const bootstrapStateBucket = Effect.fn("AWS.state.bootstrap")(function* (name?: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  if (name !== undefined) yield* Provisioning.storeName(name);
  const bucketName = createStateBucketName(accountId, region, name);
  const existed = yield* stateBucketExists(bucketName);
  yield* provisionStateBucket(bucketName, region);
  return { accountId, region, bucketName, existed };
});

/**
 * Empty and delete a state bucket (by default the account's in this region),
 * every object version included. A missing bucket is not an error.
 */
const teardownStateBucket = Effect.fn("AWS.state.teardown")(function* (name?: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  if (name !== undefined) yield* Provisioning.storeName(name);
  const bucketName = createStateBucketName(accountId, region, name);
  if (!(yield* stateBucketExists(bucketName))) {
    return { bucketName, deleted: false };
  }
  yield* deleteAllObjects(bucketName);
  yield* s3.deleteBucket({ Bucket: bucketName }).pipe(
    Effect.catchTag("NoSuchBucket", () => Effect.void),
    Effect.retry({
      while: (error) => error._tag === "OperationAborted" || error._tag === "ServiceUnavailable",
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(10)]),
    }),
  );
  return { bucketName, deleted: true };
});

/** The AWS environment of the profile core runs the operation under. */
const environment = stateEnvironment();

/**
 * The S3 state store's lifecycle, for `Alchemist.State` and `alchemy state`.
 * The store also creates its bucket on first use, so bootstrapping is only
 * needed to provision it ahead of time. S3 keeps no log stream to show.
 */
export const lifecycle: StateStoreLifecycle = {
  bootstrap: ({ name }) =>
    bootstrapStateBucket(name).pipe(
      Effect.map(({ bucketName, accountId, region, existed }) => ({
        status: existed ? ("adopted" as const) : ("created" as const),
        store: bucketName,
        location: { account: accountId, region },
      })),
      Effect.provide(environment),
    ),
  teardown: ({ name }) =>
    teardownStateBucket(name).pipe(
      Effect.map(({ bucketName, deleted }) => ({ deleted: deleted ? [bucketName] : [] })),
      Effect.provide(environment),
    ),
};

/** The state store AWS contributes. */
export const stateStore: StateStoreImpl = { layer: state, lifecycle };
