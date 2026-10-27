import { StateStoreError } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import { type DynamoDBStateService, isLeaseHeld } from "./DynamoDBState.ts";
import {
  fenceLegacyStage,
  type LegacyLocation,
  listLegacyStacks,
  listLegacyStages,
  readLegacyStage,
  unfenceLegacyStage,
  writeLegacyStage,
} from "./LegacyLayout.ts";

/**
 * Moving stages from the S3 state store to the DynamoDB one, and back.
 *
 * Each stage moves on its own, under both stores' leases:
 *
 * 1. Hold the stage's DynamoDB lease. A stage already in the catalog has
 *    moved.
 * 2. Fence the stage's S3 lease: replace it with one that never expires.
 *    Every S3 store, of any version, reads it as held by another deploy,
 *    so nothing writes the S3 copy again. A deploy that holds the lease
 *    keeps it, and the stage is reported as blocked.
 * 3. Copy every record and the output, and delete what an earlier,
 *    interrupted copy left that the source no longer has.
 * 4. Read the copy back and compare it with the source.
 * 5. Enter the stage in the DynamoDB catalog. This write is the switch: the
 *    DynamoDB store refuses a stage the S3 store has until it is there.
 *
 * A failure at any step leaves the S3 copy authoritative and, once fenced,
 * unchanged, so running the migration again converges. The S3 objects
 * are kept.
 */

export type StageMigrationStatus =
  /** Moved by this run. */
  | "migrated"
  /** Moved by an earlier run, or never in the S3 store. */
  | "already-migrated"
  /** Moved back to the S3 store by this run. */
  | "rolled-back"
  /** Not in DynamoDB, so there is nothing to roll back. */
  | "not-migrated"
  /** Another deploy holds the stage. */
  | "blocked";

export interface StageMigration {
  readonly stack: string;
  readonly stage: string;
  readonly status: StageMigrationStatus;
  /** Records moved, for `migrated` and `rolled-back`. */
  readonly records?: number;
  /** Why the stage is `blocked`. */
  readonly reason?: string;
}

/**
 * Steps a test can fail at, to leave a migration half-done: after the S3
 * lease is fenced, and after the copy is checked but before it commits.
 */
export type MigrationStep = "fenced" | "copied";

export interface MigrateOptions {
  readonly stack?: string;
  readonly stage?: string;
  /** Runs after each step; a failure stops the stage there. */
  readonly afterStep?: (
    step: MigrationStep,
    stage: { stack: string; stage: string },
  ) => Effect.Effect<void, StateStoreError>;
}

const describeLocation = (location: LegacyLocation) => `s3://${location.bucket}/${location.prefix}`;

/** A lease another deploy holds is a blocked stage, not a failed run. */
const blockedWhenHeld =
  (stack: string, stage: string) =>
  <R>(self: Effect.Effect<StageMigration, StateStoreError, R>) =>
    self.pipe(
      Effect.catchTag("StateStoreError", (error) =>
        isLeaseHeld(error)
          ? Effect.succeed<StageMigration>({
              stack,
              stage,
              status: "blocked",
              reason: error.message,
            })
          : Effect.fail(error),
      ),
    );

const migrateStage = Effect.fn(function* (
  store: DynamoDBStateService,
  legacy: LegacyLocation,
  table: string,
  stack: string,
  stage: string,
  options: MigrateOptions,
) {
  const { migration } = store;
  yield* migration.hold(stack, stage);
  if (yield* migration.cataloged(stack, stage)) {
    return { stack, stage, status: "already-migrated" } satisfies StageMigration;
  }
  const fence = yield* fenceLegacyStage(legacy, stack, stage, table).pipe(
    Effect.mapError(toStoreError),
  );
  if (!fence.fenced) {
    return {
      stack,
      stage,
      status: "blocked",
      reason: `a deploy holds the S3 state lock until ${new Date(fence.expiresAt).toISOString()}`,
    } satisfies StageMigration;
  }
  yield* options.afterStep?.("fenced", { stack, stage }) ?? Effect.void;
  const contents = yield* readLegacyStage(legacy, stack, stage).pipe(Effect.mapError(toStoreError));
  yield* migration.commitStage(
    stack,
    stage,
    contents,
    describeLocation(legacy),
    options.afterStep?.("copied", { stack, stage }),
  );
  return {
    stack,
    stage,
    status: "migrated",
    records: contents.records.size,
  } satisfies StageMigration;
});

const rollbackStage = Effect.fn(function* (
  store: DynamoDBStateService,
  legacy: LegacyLocation,
  table: string,
  stack: string,
  stage: string,
) {
  const { migration } = store;
  yield* migration.hold(stack, stage);
  if (!(yield* migration.cataloged(stack, stage))) {
    return { stack, stage, status: "not-migrated" } satisfies StageMigration;
  }
  // A stage that started in DynamoDB has no fence yet: take one, so no S3
  // store writes the stage while it is copied back.
  const fence = yield* fenceLegacyStage(legacy, stack, stage, table).pipe(
    Effect.mapError(toStoreError),
  );
  if (!fence.fenced) {
    return {
      stack,
      stage,
      status: "blocked",
      reason: `a deploy holds the S3 state lock until ${new Date(fence.expiresAt).toISOString()}`,
    } satisfies StageMigration;
  }
  const contents = yield* migration.readStage(stack, stage);
  yield* writeLegacyStage(legacy, stack, stage, contents).pipe(Effect.mapError(toStoreError));
  // Out of the catalog first: a crash after it leaves the stage fenced, and
  // the next run of either command picks it up from the S3 copy.
  yield* migration.releaseStage(stack, stage);
  yield* unfenceLegacyStage(legacy, stack, stage).pipe(Effect.mapError(toStoreError));
  return {
    stack,
    stage,
    status: "rolled-back",
    records: contents.records.size,
  } satisfies StageMigration;
});

/** Name an S3 failure in the store's error type. */
const toStoreError = (cause: { readonly message: string }) =>
  new StateStoreError({ message: cause.message });

/** The stages a migration acts on: all of them, one stack's, or one. */
const selectStages = <R>(
  all: Effect.Effect<ReadonlyArray<{ stack: string; stage: string }>, StateStoreError, R>,
  options: { stack?: string; stage?: string },
) =>
  all.pipe(
    Effect.map((stages) =>
      stages.filter(
        (entry) =>
          (options.stack === undefined || entry.stack === options.stack) &&
          (options.stage === undefined || entry.stage === options.stage),
      ),
    ),
  );

const legacyStages = (legacy: LegacyLocation) =>
  listLegacyStacks(legacy).pipe(
    Effect.flatMap((stacks) =>
      Effect.forEach(
        stacks,
        (stack) =>
          listLegacyStages(legacy, stack).pipe(
            Effect.map((stages) => stages.map((stage) => ({ stack, stage }))),
          ),
        { concurrency: 8 },
      ),
    ),
    Effect.map((stages) => stages.flat()),
    Effect.mapError(toStoreError),
  );

const located = (store: DynamoDBStateService) =>
  store.migration.target.pipe(
    Effect.flatMap(({ legacy, table }) =>
      legacy === undefined
        ? Effect.fail(
            new StateStoreError({
              message: "This DynamoDB state store has no S3 store to migrate",
            }),
          )
        : Effect.succeed({ legacy, table }),
    ),
  );

/**
 * Move every stage of the S3 store (or the selected ones) to DynamoDB.
 * Stages another deploy holds are reported as blocked; run it again once
 * they finish.
 */
export const migrateToDynamoDB = Effect.fn("AWS.state.migrate")(function* (
  store: DynamoDBStateService,
  options: MigrateOptions = {},
) {
  const { legacy, table } = yield* located(store);
  const stages = yield* selectStages(legacyStages(legacy), options);
  return yield* Effect.forEach(
    stages,
    ({ stack, stage }) =>
      migrateStage(store, legacy, table, stack, stage, options).pipe(blockedWhenHeld(stack, stage)),
    { concurrency: 4 },
  );
});

/**
 * Move every DynamoDB stage (or the selected ones) back to the S3 store,
 * for going back to a version of alchemy that only has the S3 store.
 */
export const rollbackToS3 = Effect.fn("AWS.state.rollback")(function* (
  store: DynamoDBStateService,
  options: { stack?: string; stage?: string } = {},
) {
  const { legacy, table } = yield* located(store);
  const stages = yield* selectStages(store.migration.catalog(), options);
  return yield* Effect.forEach(
    stages,
    ({ stack, stage }) =>
      rollbackStage(store, legacy, table, stack, stage).pipe(blockedWhenHeld(stack, stage)),
    { concurrency: 4 },
  );
});
