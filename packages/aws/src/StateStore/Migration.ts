import type { StateMigration, StateMigrationRequest } from "alchemy/State/State";
import { StateStoreError } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import type { DynamoDBStateService, HeldLease } from "./DynamoDBState.ts";
import {
  fenceLegacyStage,
  isLeaseHeld,
  isLegacyStageFenced,
  type LegacyLocation,
  listLegacyStacks,
  listLegacyStages,
  readLegacyStage,
  setStageAccess,
  unfenceLegacyStage,
  writeLegacyStage,
} from "./LegacyLayout.ts";

/**
 * Moving stages from the S3 state store to the DynamoDB one, and back.
 *
 * Each stage moves on its own, under both stores' leases:
 *
 * 1. Hold the stage's DynamoDB lease. A stage DynamoDB owns has moved.
 *    Read the stage and seal it once, to find out before the fence whether
 *    this store's encryption can.
 * 2. Fence the stage in S3: replace its lease with one that never expires,
 *    which every S3 store since 2.0.0-beta.84 reads as held, and deny
 *    writes to its objects in the bucket policy, which stops the versions
 *    before it. A deploy that holds the lease keeps it, and the stage is
 *    reported as blocked.
 * 3. Copy every record and the output, and delete what an earlier,
 *    interrupted copy left that the source no longer has.
 * 4. Read the copy back and compare it with the source.
 * 5. Enter the stage in the DynamoDB catalog, on condition the lease is
 *    still ours. This write is the switch: the DynamoDB store refuses a
 *    stage the S3 store has until it is there.
 * 6. Deny reads of the stage's objects too, so any older version fails at
 *    its first read instead of deploying from the copy left behind. S3 can
 *    take minutes to enforce this second policy update everywhere; writes
 *    stay denied throughout, so an older version that reads the copy in
 *    that window still can't record anything.
 *
 * A failure at any step leaves the S3 copy authoritative and, once fenced,
 * unchanged, so running the migration again converges. The S3 objects
 * are kept.
 */

/**
 * A stage's entry in the DynamoDB catalog:
 *
 * - `active`: DynamoDB holds the stage.
 * - `destroyed`: the stage was destroyed in DynamoDB. The entry stays, so an
 *   S3 copy from before the migration doesn't come back.
 * - `rolled-back`: moved back; the S3 store holds the stage again.
 */
export type CatalogStatus = "active" | "destroyed" | "rolled-back";

/** Whether DynamoDB is the stage's store, whatever the S3 store still has. */
export const ownsStage = (status: CatalogStatus | undefined) =>
  status === "active" || status === "destroyed";

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
  | "blocked"
  /** Moving the stage failed; the reason says why. */
  | "failed";

export interface StageMigration extends StateMigration {
  readonly status: StageMigrationStatus;
}

/**
 * Steps a test can fail at, to leave a run half-done: migrating, after the
 * S3 lease is fenced and after the copy is checked but before it commits;
 * rolling back, after the stage is switched back but before its DynamoDB
 * items are deleted.
 */
export type MigrationStep = "fenced" | "copied" | "switched";

export interface MigrateOptions extends Omit<StateMigrationRequest, "rollback"> {
  /** Runs after each step; a failure stops the stage there. */
  readonly afterStep?: (
    step: MigrationStep,
    stage: { stack: string; stage: string },
  ) => Effect.Effect<void, StateStoreError>;
}

const describeLocation = (location: LegacyLocation) => `s3://${location.bucket}/${location.prefix}`;

/** Name an S3 failure in the store's error type. */
const toStoreError = (cause: { readonly message?: string; readonly _tag?: string }) =>
  new StateStoreError({ message: cause.message ?? `S3 state store error: ${cause._tag}` });

/**
 * A stage's result whatever happens to it: a lease another deploy holds is
 * a blocked stage, and any other failure is reported for that stage rather
 * than stopping the others.
 */
const settle =
  (stack: string, stage: string) =>
  <R>(self: Effect.Effect<StageMigration, StateStoreError, R>) =>
    self.pipe(
      Effect.catchTag("StateStoreError", (error) =>
        Effect.succeed<StageMigration>({
          stack,
          stage,
          status: isLeaseHeld(error) ? "blocked" : "failed",
          reason: error.message,
        }),
      ),
    );

const heldInS3 = (stack: string, stage: string, expiresAt: number): StageMigration => ({
  stack,
  stage,
  status: "blocked",
  reason: `a deploy holds the S3 state lock until ${new Date(expiresAt).toISOString()}`,
});

const migrateStage = Effect.fn(function* (
  store: DynamoDBStateService,
  legacy: LegacyLocation,
  table: string,
  stack: string,
  stage: string,
  options: MigrateOptions,
) {
  const { migration } = store;
  const s3 = <A, E extends { readonly message?: string; readonly _tag?: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ) => effect.pipe(Effect.mapError(toStoreError));
  // An entry only appears or goes under the lease, so a stage DynamoDB owns
  // needs none. Its bucket policy is written again, in case a crash after
  // the commit left it out.
  const alreadyMigrated = Effect.gen(function* () {
    yield* s3(setStageAccess(legacy, stack, stage, "migrated"));
    return { stack, stage, status: "already-migrated" } satisfies StageMigration;
  });
  if (ownsStage(yield* migration.status(stack, stage))) return yield* alreadyMigrated;
  return yield* migration.exclusive(stack, stage, (lease: HeldLease) =>
    Effect.gen(function* () {
      if (ownsStage(yield* migration.status(stack, stage))) return yield* alreadyMigrated;
      // Seal a first read before fencing. A store that can't seal the stage
      // (no permission on its key), or can't open what the S3 store sealed,
      // fails here, and the S3 store keeps deploying the stage.
      yield* migration.sealStage(stack, stage, yield* s3(readLegacyStage(legacy, stack, stage)));
      const fence = yield* s3(fenceLegacyStage(legacy, stack, stage, table));
      if (!fence.fenced) return heldInS3(stack, stage, fence.expiresAt);
      yield* s3(setStageAccess(legacy, stack, stage, "fenced"));
      yield* options.afterStep?.("fenced", { stack, stage }) ?? Effect.void;
      // Sealed as it is copied, so no plaintext secret reaches the table.
      const contents = yield* migration.sealStage(
        stack,
        stage,
        yield* s3(readLegacyStage(legacy, stack, stage)),
      );
      yield* migration.commitStage(
        stack,
        stage,
        lease,
        contents,
        describeLocation(legacy),
        options.afterStep?.("copied", { stack, stage }),
      );
      yield* s3(setStageAccess(legacy, stack, stage, "migrated"));
      return {
        stack,
        stage,
        status: "migrated",
        records: contents.records.size,
      } satisfies StageMigration;
    }),
  );
});

const rollbackStage = Effect.fn(function* (
  store: DynamoDBStateService,
  legacy: LegacyLocation,
  table: string,
  stack: string,
  stage: string,
  options: MigrateOptions,
) {
  const { migration } = store;
  const s3 = <A, E extends { readonly message?: string; readonly _tag?: string }, R>(
    effect: Effect.Effect<A, E, R>,
  ) => effect.pipe(Effect.mapError(toStoreError));
  return yield* migration.exclusive(stack, stage, (lease: HeldLease) =>
    Effect.gen(function* () {
      const status = yield* migration.status(stack, stage);
      if (status === undefined) {
        // DynamoDB never took the stage. A migration that stopped before
        // its commit left it fenced in S3, with part of a copy here: drop
        // the copy and lift the fence, so the S3 store deploys it again.
        if (!(yield* s3(isLegacyStageFenced(legacy, stack, stage)))) {
          return { stack, stage, status: "not-migrated" } satisfies StageMigration;
        }
        yield* s3(setStageAccess(legacy, stack, stage, "open"));
        yield* migration.deleteStageItems(stack, stage, lease);
        yield* s3(unfenceLegacyStage(legacy, stack, stage));
        return {
          stack,
          stage,
          status: "not-migrated",
          reason: "its unfinished migration was undone, and the S3 state store holds it again",
        } satisfies StageMigration;
      }
      // Reading and writing the S3 copy needs the bucket policy lifted.
      yield* s3(setStageAccess(legacy, stack, stage, "open"));
      let records: number | undefined;
      // A `rolled-back` stage was switched back by a run that stopped
      // before cleaning up: only the cleanup is left.
      if (status !== "rolled-back") {
        // A stage that started in DynamoDB has no fence yet: take one, so
        // no S3 store writes the stage while it is copied back.
        const fence = yield* s3(fenceLegacyStage(legacy, stack, stage, table));
        if (!fence.fenced) return heldInS3(stack, stage, fence.expiresAt);
        // A destroyed stage has no contents, which empties its S3 copy. The
        // copy is for a version from before sealing, so its secrets are
        // opened.
        const contents = yield* migration.openStage(
          stack,
          stage,
          yield* migration.readStage(stack, stage),
        );
        yield* s3(writeLegacyStage(legacy, stack, stage, contents));
        // The switch back. Past it, the S3 copy is the stage's state.
        yield* migration.markRolledBack(stack, stage, lease);
        records = contents.records.size;
        yield* options.afterStep?.("switched", { stack, stage }) ?? Effect.void;
      }
      yield* migration.deleteStageItems(stack, stage, lease);
      yield* s3(unfenceLegacyStage(legacy, stack, stage));
      return {
        stack,
        stage,
        status: "rolled-back",
        ...(records === undefined ? {} : { records }),
      } satisfies StageMigration;
    }),
  );
});

/** Keep the stages a request selects: all of them, one stack's, or one. */
const selected =
  (options: { stack?: string; stage?: string }) => (entry: { stack: string; stage: string }) =>
    (options.stack === undefined || entry.stack === options.stack) &&
    (options.stage === undefined || entry.stage === options.stage);

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

const requireLegacy = <T extends { legacy: LegacyLocation | undefined }>(target: T) =>
  target.legacy === undefined
    ? Effect.fail(
        new StateStoreError({ message: "This DynamoDB state store has no S3 store to migrate" }),
      )
    : Effect.succeed({ ...target, legacy: target.legacy });

/**
 * Move every stage of the S3 store (or the selected ones) to DynamoDB,
 * creating the table if it is missing. Each stage reports its own result;
 * run it again to finish the ones blocked or failed.
 */
export const migrateToDynamoDB = Effect.fn("AWS.state.migrate")(function* (
  store: DynamoDBStateService,
  options: MigrateOptions = {},
) {
  const { legacy, table } = yield* store.migration.provision.pipe(Effect.flatMap(requireLegacy));
  const stages = (yield* legacyStages(legacy)).filter(selected(options));
  return yield* Effect.forEach(
    stages,
    ({ stack, stage }) =>
      migrateStage(store, legacy, table, stack, stage, options).pipe(settle(stack, stage)),
    { concurrency: 4 },
  );
});

/**
 * Move every DynamoDB stage (or the selected ones) back to the S3 store,
 * for going back to a version of alchemy that only has the S3 store. That
 * version can't open sealed secrets, so the copy holds them in plaintext.
 * A stage whose migration stopped before it committed is released: it never
 * left the S3 store, which deploys it again.
 */
export const rollbackToS3 = Effect.fn("AWS.state.rollback")(function* (
  store: DynamoDBStateService,
  options: MigrateOptions = {},
) {
  const { legacy, table } = yield* store.migration.names.pipe(Effect.flatMap(requireLegacy));
  const cataloged = (yield* store.migration.catalog()).filter(selected(options));
  // Stages a migration fenced in S3 and never committed are in no catalog.
  const known = new Set(cataloged.map((entry) => `${entry.stack}\u0000${entry.stage}`));
  const unfinished = yield* Effect.filter(
    (yield* legacyStages(legacy)).filter(
      (entry) => selected(options)(entry) && !known.has(`${entry.stack}\u0000${entry.stage}`),
    ),
    ({ stack, stage }) =>
      isLegacyStageFenced(legacy, stack, stage).pipe(Effect.mapError(toStoreError)),
    { concurrency: 8 },
  );
  const stages = [...cataloged, ...unfinished];
  return yield* Effect.forEach(
    stages,
    ({ stack, stage }) =>
      rollbackStage(store, legacy, table, stack, stage, options).pipe(settle(stack, stage)),
    { concurrency: 4 },
  );
});
