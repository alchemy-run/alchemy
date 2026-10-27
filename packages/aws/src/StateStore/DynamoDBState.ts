import { createHash } from "node:crypto";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import type { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import * as Provisioning from "alchemy/State/Provisioning";
import {
  type PersistedState,
  State,
  type StateService,
  StateStoreError,
} from "alchemy/State/State";
import { encodeState, reviveState } from "alchemy/State/StateEncoding";
import { recordStateStoreInit } from "alchemy/Telemetry/Metrics";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import {
  hasLegacyStage,
  type LegacyLocation,
  listLegacyStacks,
  listLegacyStages,
  normalizePrefix,
  readLegacyOutput,
  type StageContents,
} from "./LegacyLayout.ts";
import {
  createStateBucketName,
  provisionStateBucket,
  stateBucketExists,
  stateEnvironment,
  withoutSdkDebugLogs,
} from "./State.ts";

export interface DynamoDBStateOptions {
  /**
   * A store other than the account's default, by logical name: its table is
   * `alchemy-state-<name>` and its overflow bucket
   * `alchemy-state-overflow-<name>-<accountId>-<region>-an`. The table is
   * created on first use, except in CI, where `alchemy state bootstrap
   * --backend aws --name <name>` provisions it ahead.
   *
   * @default the account's default store, table `alchemy-state`
   */
  name?: string;
  /**
   * A full table name instead of one derived from
   * {@link DynamoDBStateOptions.name}, e.g. an existing table. It must have
   * a string partition key `PK` and a string sort key `SK`.
   */
  tableName?: string;
  /**
   * A full name for the S3 bucket that holds records too large for a
   * DynamoDB item, instead of one derived from
   * {@link DynamoDBStateOptions.name}. Created, with the S3 state store's
   * secure defaults, the first time a record overflows.
   *
   * @default `alchemy-state-overflow-<accountId>-<region>-an`
   */
  overflowBucketName?: string;
  /**
   * The S3 state store whose stages this store takes over. A stage that is
   * still there and not yet in DynamoDB is refused until `alchemy state
   * migrate --backend aws` moves it; `false` skips the check.
   *
   * @default the S3 store of the same name, `alchemy-state-<name>-<accountId>-<region>-an`
   */
  migrateFrom?: { readonly bucketName?: string; readonly prefix?: string } | false;
  /**
   * Size in bytes of a record's encoded state above which it is stored in
   * the overflow bucket, with the DynamoDB item holding a reference to it.
   * A DynamoDB item holds at most 400 KB.
   *
   * @default 307200 (300 KiB)
   */
  overflowThreshold?: number;
}

/** The backend name `alchemy state ... --backend` addresses this store by. */
export const DYNAMODB_STATE_BACKEND = "aws";

const HELD_PREFIX = "another deploy holds";

/** Whether the store failed because another deploy holds the stage. */
export const isLeaseHeld = (error: StateStoreError) => error.message.startsWith(HELD_PREFIX);

/** Context required by the distilled DynamoDB and S3 operations. */
type AwsDeps = Credentials | HttpClient | Region;

type Item = { [key: string]: dynamodb.AttributeValue | undefined };

const DEFAULT_OVERFLOW_THRESHOLD = 300 * 1024;

/** Maximum number of requests DynamoDB accepts in one BatchWriteItem call. */
const BATCH_WRITE_SIZE = 25;

/** Maximum number of keys S3 accepts in one DeleteObjects call. */
const S3_DELETE_BATCH_SIZE = 1000;

/** Backoff for the writes a BatchWriteItem call leaves unprocessed. */
const unprocessedBackoff = Schedule.exponential("200 millis").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(5))),
  ),
  Schedule.upTo({ times: 8 }),
);

/** How long a lease stays valid without a refresh. */
const LEASE_TTL_MS = 60_000;

/** How long a passing lease check is trusted. A failure is never cached. */
const LEASE_CHECK_TTL_MS = 5_000;

/** Sort key prefix of resource and action records. */
const RECORD = "RECORD#";
/** Sort key of a stage's stack output. */
const OUTPUT = "OUTPUT";
/** Sort key of a stage's deploy lease. */
const LEASE = "LEASE";
/** Partition key of the stage catalog. */
const CATALOG = "CATALOG";

/** Escape the key separator out of a stack or stage name. */
const part = (name: string) => name.replaceAll("%", "%25").replaceAll("#", "%23");

const stagePk = (stack: string, stage: string) => `STAGE#${part(stack)}#${part(stage)}`;
/** The catalog sort key prefix of a stack's stages. */
const catalogPrefix = (stack: string) => `STAGE#${part(stack)}#`;
const catalogSk = (stack: string, stage: string) => `${catalogPrefix(stack)}${part(stage)}`;

const S = (value: string): dynamodb.AttributeValue => ({ S: value });
const N = (value: number): dynamodb.AttributeValue => ({ N: String(value) });
const str = (item: Item | undefined, name: string) => item?.[name]?.S;

/**
 * Build the default table name. Table names are unique per account and
 * region, so they need no account or region suffix.
 */
export const createStateTableName = (name?: string) =>
  `alchemy-state${name === undefined ? "" : `-${name}`}`;

/** Build the default overflow bucket name, in the account-regional namespace. */
export const createOverflowBucketName = (accountId: string, region: string, name?: string) =>
  `alchemy-state-overflow-${name === undefined ? "" : `${name}-`}${accountId}-${region}-an`.toLowerCase();

const toError = (cause: unknown) =>
  new StateStoreError({
    message:
      cause instanceof Error ? cause.message : `DynamoDB state store error: ${String(cause)}`,
    cause: cause instanceof Error ? cause : undefined,
  });

/**
 * State store backed by an AWS DynamoDB table.
 *
 * Every stack and stage on the account shares one on-demand table with a
 * string partition key `PK` and sort key `SK`:
 *
 * ```
 * STAGE#{stack}#{stage}   RECORD#{sha256(fqn)}   one resource's state
 * STAGE#{stack}#{stage}   OUTPUT                 the stack's output
 * STAGE#{stack}#{stage}   LEASE                  the deploy lease
 * CATALOG                 STAGE#{stack}#{stage}  the stage catalog
 * ```
 *
 * A deploy takes the stage's lease, then loads every record of the stage
 * with one paginated Query and serves reads from that snapshot. Writes go
 * to DynamoDB immediately, one item each. A record larger than
 * `overflowThreshold` is stored in an S3 overflow bucket, and its item
 * holds the object's key.
 *
 * Concurrent deploys of one stack and stage contend for the lease, a
 * conditional put. The second deploy fails immediately instead of mixing
 * rows. The holder refreshes the lease until the store closes. A killed
 * process stops refreshing, the lease expires, and the next deploy can
 * take it.
 *
 * The table is created lazily on the first state operation if it does not
 * already exist, with point-in-time recovery enabled. The overflow bucket
 * is created the first time a record needs it.
 *
 * ### Using the DynamoDB State Store
 * Pass `AWS.state()` as the `state` option of a Stack.
 *
 * **Example:** Default table
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "@alchemy.run/aws";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   { providers: AWS.providers(), state: AWS.state() },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * **Example:** A named store
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers(),
 *     state: AWS.state({ name: "team-a" }), // table alchemy-state-team-a
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * ### Provisioning the Store in CI
 * In CI a missing table fails the run. Create it, and its overflow bucket,
 * once ahead of time:
 *
 * ```sh
 * alchemy state bootstrap --backend aws --profile <your-ci-profile>
 * ```
 *
 */
export const dynamoDBState = (options: DynamoDBStateOptions = {}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<AwsDeps | AWSEnvironment>();

      // Bind the leases to this layer's scope. The cached effect runs on
      // the first state operation, which may sit in a shorter scope.
      const make = Scope.provide(makeDynamoDBState(options), scope).pipe(
        recordStateStoreInit,
        Effect.orDie,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  ).pipe(Layer.provideMerge(stateEnvironment()), Layer.orDie);

interface StoredRecord {
  /** The encoded state, as JSON. */
  readonly text: string;
}

interface HeldLease {
  readonly checkLive: Effect.Effect<void, StateStoreError>;
}

/**
 * A passing check is trusted for `ttlMs`, so a burst of operations does
 * one round-trip. A failing check is never cached.
 */
const amortizeCheck = (
  checkLive: Effect.Effect<void, StateStoreError>,
  ttlMs: number,
  lastOkAt: number | undefined,
): Effect.Effect<void, StateStoreError> => {
  return Effect.suspend(() => {
    if (lastOkAt !== undefined && Date.now() - lastOkAt < ttlMs) {
      return Effect.void;
    }
    return checkLive.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          lastOkAt = Date.now();
        }),
      ),
    );
  });
};

/**
 * One cached effect per key. A failed effect is dropped rather than cached,
 * so the next call retries it.
 */
const keyedCache = <A>() => {
  const mutex = Semaphore.makeUnsafe(1);
  const entries = new Map<string, Effect.Effect<A, StateStoreError>>();
  return {
    entries,
    get: (key: string, make: Effect.Effect<A, StateStoreError>) =>
      Semaphore.withPermits(
        mutex,
        1,
      )(
        Effect.gen(function* () {
          const existing = entries.get(key);
          if (existing !== undefined) return existing;
          const cached = yield* Effect.cached(
            make.pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (entries.get(key) === cached) entries.delete(key);
                }),
              ),
            ),
          );
          entries.set(key, cached);
          return cached;
        }),
      ).pipe(Effect.flatMap((effect) => effect)),
  };
};

/**
 * Construct a DynamoDB-backed {@link StateService}. Leases are bound to the
 * ambient scope; callers that need them to outlive the first operation
 * bind this effect to a longer scope with `Scope.provide`.
 *
 * Construction itself never touches AWS: resolving the environment and
 * ensuring the table exists run once, on the first state operation.
 */
export const makeDynamoDBState = (options: DynamoDBStateOptions = {}) =>
  makeStore(options).pipe(withoutSdkDebugLogs);

const makeStore = Effect.fn(function* (options: DynamoDBStateOptions) {
  const leaseScope = yield* Effect.scope;
  // Captured under `withoutSdkDebugLogs` (below), so every store call runs
  // with the raised floor: request payloads are state, and state holds
  // secrets.
  const context = yield* Effect.context<AwsDeps | AWSEnvironment>();
  const run = <A, E>(effect: Effect.Effect<A, E, AwsDeps>): Effect.Effect<A, StateStoreError> =>
    effect.pipe(Effect.provideContext(context), Effect.mapError(toError));

  const threshold = options.overflowThreshold ?? DEFAULT_OVERFLOW_THRESHOLD;
  const label = "DynamoDB";

  // Resolve names and ensure the table exists on the first operation.
  const target = yield* Effect.cached(
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      if (options.name !== undefined) yield* Provisioning.storeName(options.name);
      const table = options.tableName ?? createStateTableName(options.name);
      const bucket =
        options.overflowBucketName ?? createOverflowBucketName(accountId, region, options.name);
      const legacy: LegacyLocation | undefined =
        options.migrateFrom === false
          ? undefined
          : {
              bucket:
                options.migrateFrom?.bucketName ??
                createStateBucketName(accountId, region, options.name),
              prefix: normalizePrefix(options.migrateFrom?.prefix),
            };
      const observed = yield* describeStateTable(table);
      if (observed === undefined) {
        yield* Provisioning.deployMissing(
          {
            backend: DYNAMODB_STATE_BACKEND,
            name: options.name,
            label: `DynamoDB state table '${table}'`,
          },
          ensureStateTable(table),
        );
      } else {
        yield* validateKeySchema(observed);
        if (observed.TableStatus !== "ACTIVE") yield* waitForTableActive(table);
      }
      return { table, bucket, region, legacy };
    }).pipe(Effect.provideContext(context), Effect.mapError(toError)),
  );

  const use = <A, E>(
    f: (target: {
      table: string;
      bucket: string;
      region: string;
      legacy: LegacyLocation | undefined;
    }) => Effect.Effect<A, E, AwsDeps>,
  ): Effect.Effect<A, StateStoreError> => target.pipe(Effect.flatMap((t) => run(f(t))));

  // The overflow bucket is created the first time a record needs it.
  const overflowBucket = yield* Effect.cached(
    use(({ bucket, region }) =>
      Effect.gen(function* () {
        if (yield* stateBucketExists(bucket)) return bucket;
        yield* Provisioning.deployMissing(
          {
            backend: DYNAMODB_STATE_BACKEND,
            name: options.name,
            label: `DynamoDB state overflow bucket '${bucket}'`,
          },
          provisionStateBucket(bucket, region),
        );
        return bucket;
      }),
    ),
  );

  const hashFqn = (fqn: string) =>
    Effect.sync(() => createHash("sha256").update(fqn).digest("hex"));

  const recordSk = (fqn: string) => hashFqn(fqn).pipe(Effect.map((hash) => `${RECORD}${hash}`));

  const blobPrefix = (stack: string, stage: string) =>
    `${encodeURIComponent(stack)}/${encodeURIComponent(stage)}/`;

  /** The encoded text of an item: inline, or read from the overflow bucket. */
  const itemText = Effect.fn(function* (item: Item) {
    const inline = str(item, "data");
    if (inline !== undefined) return inline;
    const ref = str(item, "ref");
    if (ref === undefined) {
      return yield* new StateStoreError({
        message: `DynamoDB state item ${str(item, "PK")}/${str(item, "SK")} has neither data nor ref`,
      });
    }
    const text = yield* use(({ bucket }) =>
      s3.getObject({ Bucket: bucket, Key: ref }).pipe(
        Effect.flatMap((result) =>
          result.Body === undefined
            ? Effect.succeed(undefined)
            : Stream.mkString(Stream.decodeText(result.Body)),
        ),
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
      ),
    );
    // A missing body is corruption, never a missing resource.
    if (text === undefined) {
      return yield* new StateStoreError({
        message: `DynamoDB state item ${str(item, "PK")}/${str(item, "SK")} references missing overflow object '${ref}'`,
      });
    }
    return text;
  });

  const parse = <T>(text: string, what: string) =>
    Effect.try({
      try: () => JSON.parse(text, reviveState) as T,
      catch: (cause) =>
        new StateStoreError({
          message: `Failed to parse DynamoDB state ${what}`,
          cause: cause instanceof Error ? cause : undefined,
        }),
    });

  /**
   * Write an item holding `value`, inline or as an overflow reference.
   * The overflow object is uploaded before the item that references it is
   * committed, and the object the item referenced before is deleted after.
   */
  const putPayload = Effect.fn(function* (
    key: { PK: string; SK: string; stack: string; stage: string },
    text: string,
    attributes: Item,
  ) {
    const bytes = yield* Effect.sync(() => new TextEncoder().encode(text).length);
    let payload: Item;
    if (bytes > threshold) {
      const bucket = yield* overflowBucket;
      // A fresh key per write, so the committed item's object is never
      // overwritten in place.
      const ref = `${blobPrefix(key.stack, key.stage)}${encodeURIComponent(key.SK)}-${yield* Effect.sync(() => crypto.randomUUID())}.json`;
      yield* run(
        s3.putObject({
          Bucket: bucket,
          Key: ref,
          Body: text,
          ContentType: "application/json",
        }),
      );
      payload = { ref: S(ref) };
    } else {
      payload = { data: S(text) };
    }
    const previous = yield* use(({ table }) =>
      dynamodb.putItem({
        TableName: table,
        Item: { PK: S(key.PK), SK: S(key.SK), ...attributes, ...payload },
        ReturnValues: "ALL_OLD",
      }),
    );
    yield* deleteOverflow(str(previous.Attributes, "ref"), str(payload, "ref"));
  });

  /** Delete an overflow object no item references any more. Best effort. */
  const deleteOverflow = (ref: string | undefined, keep?: string) =>
    ref === undefined || ref === keep
      ? Effect.void
      : use(({ bucket }) => s3.deleteObject({ Bucket: bucket, Key: ref })).pipe(Effect.ignore);

  /** Delete items in batches, retrying the ones DynamoDB leaves unprocessed. */
  const deleteItems = (keys: ReadonlyArray<{ PK: string; SK: string }>) =>
    use(({ table }) =>
      Effect.forEach(
        Arr.chunksOf(keys, BATCH_WRITE_SIZE),
        (batch) =>
          Effect.gen(function* () {
            let requests: dynamodb.WriteRequest[] = batch.map((key) => ({
              DeleteRequest: { Key: { PK: S(key.PK), SK: S(key.SK) } },
            }));
            yield* Effect.gen(function* () {
              const result = yield* dynamodb.batchWriteItem({
                RequestItems: { [table]: requests },
              });
              requests = result.UnprocessedItems?.[table] ?? [];
            }).pipe(
              Effect.repeat({
                schedule: unprocessedBackoff,
                until: () => requests.length === 0,
              }),
            );
            if (requests.length > 0) {
              return yield* new StateStoreError({
                message: `DynamoDB left ${requests.length} state deletes unprocessed`,
              });
            }
          }),
        { discard: true },
      ),
    );

  /** Every item of a partition, across pagination, strongly consistent. */
  const queryPartition = (pk: string, skPrefix?: string, projection?: string) =>
    use(({ table }) =>
      dynamodb.query
        .pages({
          TableName: table,
          ConsistentRead: true,
          KeyConditionExpression:
            skPrefix === undefined ? "PK = :pk" : "PK = :pk AND begins_with(SK, :sk)",
          ExpressionAttributeValues:
            skPrefix === undefined ? { ":pk": S(pk) } : { ":pk": S(pk), ":sk": S(skPrefix) },
          ...(projection === undefined
            ? {}
            : {
                ProjectionExpression: projection,
                ExpressionAttributeNames: { "#ref": "ref" },
              }),
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.Items ?? [])),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
        ),
    );

  const heldError = (stack: string, stage: string) =>
    new StateStoreError({
      message: `${HELD_PREFIX} the ${label} state lock '${stack}/${stage}'`,
    });

  const lostError = (stack: string, stage: string) =>
    new StateStoreError({
      message: `the ${label} state lock '${stack}/${stage}' was lost mid-run; refusing to continue unlocked`,
    });

  const leaseKey = (stack: string, stage: string) => ({
    PK: S(stagePk(stack, stage)),
    SK: S(LEASE),
  });

  /** Write the lease when `condition` holds; `false` when it doesn't. */
  const putLease = (
    stack: string,
    stage: string,
    token: string,
    expiresAt: number,
    condition: {
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Item;
    },
  ) =>
    use(({ table }) =>
      dynamodb
        .putItem({
          TableName: table,
          Item: { ...leaseKey(stack, stage), token: S(token), expiresAt: N(expiresAt) },
          ...condition,
        })
        .pipe(
          Effect.as(true),
          Effect.catchTag("ConditionalCheckFailedException", () => Effect.succeed(false)),
        ),
    );

  const acquireLease = Effect.fn(function* (stack: string, stage: string) {
    const token = yield* Effect.sync(() => crypto.randomUUID());
    const now = yield* Clock.currentTimeMillis;
    // Take the lease when nobody holds it or the holder let it expire.
    const acquired = yield* putLease(stack, stage, token, now + LEASE_TTL_MS, {
      ConditionExpression: "attribute_not_exists(PK) OR #expiresAt <= :now",
      ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
      ExpressionAttributeValues: { ":now": N(now) },
    });
    if (!acquired) return yield* Effect.fail(heldError(stack, stage));

    const cursor = { lost: false };
    const gate = Semaphore.makeUnsafe(1);

    const renew = Semaphore.withPermits(
      gate,
      1,
    )(
      Effect.gen(function* () {
        if (cursor.lost) return;
        const renewedAt = yield* Clock.currentTimeMillis;
        const renewed = yield* putLease(stack, stage, token, renewedAt + LEASE_TTL_MS, {
          ConditionExpression: "#token = :token",
          ExpressionAttributeNames: { "#token": "token" },
          ExpressionAttributeValues: { ":token": S(token) },
        });
        if (!renewed) cursor.lost = true;
      }),
    ).pipe(
      Effect.retry({
        while: () => !cursor.lost,
        schedule: Schedule.spaced("1 second"),
        times: 3,
      }),
      Effect.catch(() =>
        Effect.sync(() => {
          cursor.lost = true;
        }),
      ),
    );

    const verify = Semaphore.withPermits(
      gate,
      1,
    )(
      Effect.gen(function* () {
        if (cursor.lost) return yield* Effect.fail(lostError(stack, stage));
        const existing = yield* use(({ table }) =>
          dynamodb.getItem({
            TableName: table,
            Key: leaseKey(stack, stage),
            ConsistentRead: true,
          }),
        );
        if (str(existing.Item, "token") !== token) {
          cursor.lost = true;
          return yield* Effect.fail(lostError(stack, stage));
        }
        const observedAt = yield* Clock.currentTimeMillis;
        if (Number(existing.Item?.expiresAt?.N ?? 0) <= observedAt) {
          // The lease lapsed without anyone taking it: a refresh queued
          // behind a large deploy's writes missed its window. Take it back,
          // on condition it is still ours, so a deploy that took it in the
          // meantime wins and this one stops.
          const reclaimed = yield* putLease(stack, stage, token, observedAt + LEASE_TTL_MS, {
            ConditionExpression: "#token = :token",
            ExpressionAttributeNames: { "#token": "token" },
            ExpressionAttributeValues: { ":token": S(token) },
          });
          if (!reclaimed) {
            cursor.lost = true;
            return yield* Effect.fail(lostError(stack, stage));
          }
        }
      }),
    );

    // Stop the refresh before releasing, so a refresh cannot land after
    // the lease has been released.
    yield* Scope.addFinalizer(
      leaseScope,
      Semaphore.withPermits(
        gate,
        1,
      )(
        Effect.gen(function* () {
          cursor.lost = true;
          yield* use(({ table }) =>
            dynamodb
              .deleteItem({
                TableName: table,
                Key: leaseKey(stack, stage),
                ConditionExpression: "#token = :token",
                ExpressionAttributeNames: { "#token": "token" },
                ExpressionAttributeValues: { ":token": S(token) },
              })
              .pipe(Effect.catchTag("ConditionalCheckFailedException", () => Effect.void)),
          );
        }).pipe(Effect.ignore),
      ),
    );
    yield* renew.pipe(
      Effect.delay(Duration.millis(Math.floor(LEASE_TTL_MS / 3))),
      Effect.forever,
      Effect.interruptible,
      Effect.forkIn(leaseScope),
    );

    // The conditional put just proved the lease, so the first check is free.
    return {
      checkLive: amortizeCheck(verify, LEASE_CHECK_TTL_MS, Date.now()),
    } satisfies HeldLease;
  });

  const migrateCommand = `alchemy state migrate --backend ${DYNAMODB_STATE_BACKEND}${options.name === undefined ? "" : ` --name ${options.name}`}`;

  /** The stage's catalog entry, or `undefined` when DynamoDB doesn't know it. */
  const catalogEntry = (stack: string, stage: string) =>
    use(({ table }) =>
      dynamodb.getItem({
        TableName: table,
        Key: { PK: S(CATALOG), SK: S(catalogSk(stack, stage)) },
        ConsistentRead: true,
      }),
    ).pipe(Effect.map((result) => result.Item));

  /**
   * Refuse a stage the S3 store still has and DynamoDB doesn't know: its
   * state has not moved, and serving an empty stage would redeploy it.
   */
  const refuseUnmigrated = Effect.fn(function* (stack: string, stage: string) {
    const legacy = yield* use(({ legacy }) => Effect.succeed(legacy));
    if (legacy === undefined) return;
    if ((yield* catalogEntry(stack, stage)) !== undefined) return;
    if (!(yield* use(() => hasLegacyStage(legacy, stack, stage)))) return;
    return yield* new StateStoreError({
      message: `Stage '${stack}/${stage}' is still in the S3 state store (s3://${legacy.bucket}/${legacy.prefix}). Run '${migrateCommand}' to move it to DynamoDB.`,
      requires: { action: "upgrade", command: migrateCommand },
    });
  });

  /** Every item of a stage as contents, without the migration check. */
  const readStage = Effect.fn(function* (stack: string, stage: string) {
    const items = yield* queryPartition(stagePk(stack, stage));
    const records = new Map<string, string>();
    let output: string | undefined;
    yield* Effect.forEach(
      items,
      (item) =>
        Effect.gen(function* () {
          const sk = str(item, "SK");
          if (sk === OUTPUT) output = yield* itemText(item);
          else if (sk?.startsWith(RECORD)) {
            const fqn = str(item, "fqn");
            if (fqn !== undefined) records.set(fqn, yield* itemText(item));
          }
        }),
      { concurrency: 16, discard: true },
    );
    return { records, output } satisfies StageContents;
  });

  /** Load every record of a stage into a snapshot keyed by FQN. */
  const loadStage = Effect.fn(function* (stack: string, stage: string) {
    const [items] = yield* Effect.all(
      [queryPartition(stagePk(stack, stage), RECORD), refuseUnmigrated(stack, stage)],
      { concurrency: 2 },
    );
    const records = yield* Effect.forEach(
      items,
      (item) =>
        Effect.gen(function* () {
          const fqn = str(item, "fqn");
          if (fqn === undefined) {
            return yield* new StateStoreError({
              message: `DynamoDB state item ${str(item, "PK")}/${str(item, "SK")} has no fqn`,
            });
          }
          return [fqn, { text: yield* itemText(item) }] as const;
        }),
      { concurrency: 16 },
    );
    return new Map<string, StoredRecord>(records);
  });

  // One lease per (stack, stage), taken on the first operation and held
  // for the store's lifetime. The snapshot is cached apart from the lease
  // so a failed load retries without re-taking the lease this store holds.
  const leases = keyedCache<HeldLease>();
  const snapshots = keyedCache<Map<string, StoredRecord>>();
  // Stages this store has entered in the catalog.
  const registered = keyedCache<void>();

  const guarded = <A>(
    request: { stack: string; stage: string },
    op: (records: Map<string, StoredRecord>) => Effect.Effect<A, StateStoreError>,
  ): Effect.Effect<A, StateStoreError> => {
    const key = `${request.stack}/${request.stage}`;
    return leases.get(key, acquireLease(request.stack, request.stage)).pipe(
      Effect.flatMap((lease) => lease.checkLive),
      Effect.andThen(snapshots.get(key, loadStage(request.stack, request.stage))),
      Effect.flatMap(op),
    );
  };

  const verifyHeldLeases: Effect.Effect<void, StateStoreError> = Effect.suspend(() =>
    Effect.forEach(
      Array.from(leases.entries.values()),
      (lease) => lease.pipe(Effect.flatMap((held) => held.checkLive)),
      { discard: true },
    ),
  );

  /**
   * Enter the stage in the catalog `listStacks` and `listStages` read, once
   * per stage per store.
   */
  const register = (stack: string, stage: string) =>
    registered.get(
      `${stack}/${stage}`,
      use(({ table }) =>
        dynamodb
          .putItem({
            TableName: table,
            Item: {
              PK: S(CATALOG),
              SK: S(catalogSk(stack, stage)),
              stack: S(stack),
              stage: S(stage),
            },
            // Keep an existing entry, and the migration record it may hold.
            ConditionExpression: "attribute_not_exists(PK)",
          })
          .pipe(Effect.catchTag("ConditionalCheckFailedException", () => Effect.void)),
      ).pipe(Effect.asVoid),
    );

  /** Every cataloged stage, of one stack or all of them, in one query. */
  const catalog = (stack?: string) =>
    queryPartition(CATALOG, stack === undefined ? "STAGE#" : catalogPrefix(stack)).pipe(
      Effect.map((items) =>
        items.flatMap((item) => {
          const stack = str(item, "stack");
          const stage = str(item, "stage");
          return stack === undefined || stage === undefined ? [] : [{ stack, stage }];
        }),
      ),
    );

  /** Stages of a stack, in DynamoDB or still in the S3 store. */
  const listStages = (stack: string) =>
    Effect.all(
      [
        catalog(stack).pipe(Effect.map((entries) => entries.map((entry) => entry.stage))),
        use(({ legacy }) =>
          legacy === undefined ? Effect.succeed([]) : listLegacyStages(legacy, stack),
        ),
      ],
      { concurrency: 2 },
    ).pipe(Effect.map(([own, legacy]) => Array.from(new Set([...own, ...legacy]))));

  /** Delete a stage's records, output, overflow objects and catalog entry. */
  const deleteStage = (stack: string, stage: string) =>
    guarded({ stack, stage }, (records) =>
      Effect.gen(function* () {
        const pk = stagePk(stack, stage);
        const items = yield* queryPartition(pk, undefined, "PK, SK, #ref");
        // Leave the lease. Releasing it here would open the stage before
        // this delete finishes, and the store still holds the lock.
        const keys = items
          .map((item) => ({ PK: str(item, "PK")!, SK: str(item, "SK")! }))
          .filter((key) => key.SK !== LEASE);
        yield* deleteItems(keys);
        records.clear();
        // Overflow objects of the stage, including any a crashed write
        // uploaded but never committed.
        yield* use(({ bucket }) =>
          Effect.gen(function* () {
            if (!(yield* stateBucketExists(bucket))) return;
            const objects = yield* s3.listObjectsV2
              .pages({ Bucket: bucket, Prefix: blobPrefix(stack, stage) })
              .pipe(
                Stream.flatMap((page) => Stream.fromIterable(page.Contents ?? [])),
                Stream.map((object) => object.Key),
                Stream.filter((key): key is string => key !== undefined),
                Stream.runCollect,
                Effect.map((keys) => Array.from(keys)),
              );
            yield* Effect.forEach(
              Arr.chunksOf(objects, S3_DELETE_BATCH_SIZE),
              (batch) =>
                s3.deleteObjects({
                  Bucket: bucket,
                  Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
                }),
              { discard: true },
            );
          }),
        );
        yield* deleteItems([{ PK: CATALOG, SK: catalogSk(stack, stage) }]);
        // A later write to the stage enters it in the catalog again.
        registered.entries.delete(`${stack}/${stage}`);
      }),
    );

  const state: StateService = {
    id: "dynamodb",
    getVersion: () => Effect.succeed(STATE_STORE_VERSION),
    // A stack is listed while it has a cataloged stage, or a stage the S3
    // store still has.
    listStacks: () =>
      verifyHeldLeases.pipe(
        Effect.andThen(
          Effect.all(
            [
              catalog(),
              use(({ legacy }) =>
                legacy === undefined ? Effect.succeed([]) : listLegacyStacks(legacy),
              ),
            ],
            { concurrency: 2 },
          ),
        ),
        Effect.map(([entries, legacy]) =>
          Array.from(new Set([...entries.map((entry) => entry.stack), ...legacy])),
        ),
      ),
    listStages: (stack) => verifyHeldLeases.pipe(Effect.andThen(listStages(stack))),
    get: (request) =>
      guarded(request, (records) => {
        const record = records.get(request.fqn);
        return record === undefined
          ? Effect.succeed(undefined)
          : parse<PersistedState>(record.text, `record '${request.fqn}'`);
      }),
    getReplacedResources: (request) =>
      guarded(request, (records) =>
        Effect.forEach(Array.from(records), ([fqn, record]) =>
          parse<PersistedState>(record.text, `record '${fqn}'`),
        ).pipe(Effect.map((values) => values.filter((value) => value.status === "replaced"))),
      ) as ReturnType<StateService["getReplacedResources"]>,
    set: (request) =>
      guarded(request, (records) =>
        Effect.gen(function* () {
          yield* register(request.stack, request.stage);
          const text = JSON.stringify(encodeState(request.value));
          yield* putPayload(
            {
              PK: stagePk(request.stack, request.stage),
              SK: yield* recordSk(request.fqn),
              stack: request.stack,
              stage: request.stage,
            },
            text,
            { fqn: S(request.fqn) },
          );
          records.set(request.fqn, { text });
          return request.value;
        }),
      ),
    delete: (request) =>
      guarded(request, (records) =>
        Effect.gen(function* () {
          const previous = yield* use(({ table }) =>
            Effect.flatMap(recordSk(request.fqn), (sk) =>
              dynamodb.deleteItem({
                TableName: table,
                Key: { PK: S(stagePk(request.stack, request.stage)), SK: S(sk) },
                ReturnValues: "ALL_OLD",
              }),
            ),
          );
          records.delete(request.fqn);
          yield* deleteOverflow(str(previous.Attributes, "ref"));
        }),
      ),
    // A stack-wide delete locks every stage it is about to remove, so a
    // concurrent deploy fails the lease instead of racing the delete.
    deleteStack: ({ stack, stage }) =>
      stage === undefined
        ? verifyHeldLeases.pipe(
            Effect.andThen(listStages(stack)),
            Effect.flatMap((stages) =>
              Effect.forEach(stages, (found) => deleteStage(stack, found), { discard: true }),
            ),
          )
        : deleteStage(stack, stage),
    list: (request) => guarded(request, (records) => Effect.succeed(Array.from(records.keys()))),
    // Always read fresh, without the lease: cross-stack references read
    // the outputs of stages another deploy may hold.
    getOutput: Effect.fn(function* (request) {
      const result = yield* use(({ table }) =>
        dynamodb.getItem({
          TableName: table,
          Key: { PK: S(stagePk(request.stack, request.stage)), SK: S(OUTPUT) },
          ConsistentRead: true,
        }),
      );
      if (result.Item !== undefined) {
        return yield* parse<unknown>(yield* itemText(result.Item), "stack output");
      }
      // A stage that hasn't moved yet keeps its output in the S3 store.
      // Reading it takes no lease, so a reference to it still resolves.
      const legacy = yield* use(({ legacy }) => Effect.succeed(legacy));
      if (legacy === undefined) return undefined;
      if ((yield* catalogEntry(request.stack, request.stage)) !== undefined) return undefined;
      return yield* use(() => readLegacyOutput(legacy, request.stack, request.stage));
    }),
    setOutput: (request) =>
      guarded(request, () =>
        Effect.gen(function* () {
          if (request.value === undefined) {
            const previous = yield* use(({ table }) =>
              dynamodb.deleteItem({
                TableName: table,
                Key: { PK: S(stagePk(request.stack, request.stage)), SK: S(OUTPUT) },
                ReturnValues: "ALL_OLD",
              }),
            );
            yield* deleteOverflow(str(previous.Attributes, "ref"));
            return request.value;
          }
          yield* register(request.stack, request.stage);
          yield* putPayload(
            {
              PK: stagePk(request.stack, request.stage),
              SK: OUTPUT,
              stack: request.stack,
              stage: request.stage,
            },
            JSON.stringify(encodeState(request.value)),
            {},
          );
          return request.value;
        }),
      ),
  };

  /**
   * Hold the stage's lease without the migration check, for the migration
   * itself.
   */
  const hold = (stack: string, stage: string) =>
    leases
      .get(`${stack}/${stage}`, acquireLease(stack, stage))
      .pipe(Effect.flatMap((lease) => lease.checkLive));

  /**
   * Make the stage hold exactly `contents`, check it does, and enter it in
   * the catalog: the commit that makes DynamoDB the stage's store.
   */
  const commitStage = Effect.fn(function* (
    stack: string,
    stage: string,
    contents: StageContents,
    migratedFrom: string,
    beforeCommit: Effect.Effect<void, StateStoreError> = Effect.void,
  ) {
    yield* hold(stack, stage);
    const pk = stagePk(stack, stage);
    const wanted = new Set(yield* Effect.forEach(Array.from(contents.records.keys()), recordSk));
    if (contents.output !== undefined) wanted.add(OUTPUT);
    // Items an earlier, interrupted copy left that the source no longer has.
    const stale = (yield* queryPartition(pk, undefined, "PK, SK, #ref")).filter((item) => {
      const sk = str(item, "SK");
      return sk !== LEASE && sk !== undefined && !wanted.has(sk);
    });
    yield* deleteItems(stale.map((item) => ({ PK: str(item, "PK")!, SK: str(item, "SK")! })));
    yield* Effect.forEach(stale, (item) => deleteOverflow(str(item, "ref")), { discard: true });
    yield* Effect.forEach(
      Array.from(contents.records),
      ([fqn, text]) =>
        Effect.flatMap(recordSk(fqn), (sk) =>
          putPayload({ PK: pk, SK: sk, stack, stage }, text, { fqn: S(fqn) }),
        ),
      { concurrency: 16, discard: true },
    );
    if (contents.output !== undefined) {
      yield* putPayload({ PK: pk, SK: OUTPUT, stack, stage }, contents.output, {});
    }
    // Read back what landed before it becomes the stage's state.
    const copied = yield* readStage(stack, stage);
    const mismatched = [
      ...Array.from(contents.records).filter(([fqn, text]) => copied.records.get(fqn) !== text),
      ...Array.from(copied.records.keys()).filter((fqn) => !contents.records.has(fqn)),
    ];
    if (mismatched.length > 0 || copied.output !== contents.output) {
      return yield* new StateStoreError({
        message: `DynamoDB copy of '${stack}/${stage}' does not match its source (${mismatched.length} records differ${copied.output !== contents.output ? ", output differs" : ""})`,
      });
    }
    yield* beforeCommit;
    const migratedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* use(({ table }) =>
      dynamodb.putItem({
        TableName: table,
        Item: {
          PK: S(CATALOG),
          SK: S(catalogSk(stack, stage)),
          stack: S(stack),
          stage: S(stage),
          migratedFrom: S(migratedFrom),
          migratedAt: S(migratedAt),
        },
      }),
    );
    snapshots.entries.delete(`${stack}/${stage}`);
  });

  /**
   * Take the stage out of DynamoDB: delete its items and catalog entry, so
   * the S3 store is its store again.
   */
  const releaseStage = Effect.fn(function* (stack: string, stage: string) {
    yield* hold(stack, stage);
    const items = (yield* queryPartition(stagePk(stack, stage), undefined, "PK, SK, #ref")).filter(
      (item) => str(item, "SK") !== LEASE,
    );
    // The catalog entry goes first: once it is gone the stage is the S3
    // store's, whatever of its items a crash leaves behind.
    yield* deleteItems([{ PK: CATALOG, SK: catalogSk(stack, stage) }]);
    yield* deleteItems(items.map((item) => ({ PK: str(item, "PK")!, SK: str(item, "SK")! })));
    yield* Effect.forEach(items, (item) => deleteOverflow(str(item, "ref")), { discard: true });
    registered.entries.delete(`${stack}/${stage}`);
    snapshots.entries.delete(`${stack}/${stage}`);
  });

  return {
    ...state,
    migration: {
      target: use((target) => Effect.succeed(target)),
      catalog: () => catalog(),
      cataloged: (stack: string, stage: string) =>
        catalogEntry(stack, stage).pipe(Effect.map((entry) => entry !== undefined)),
      hold,
      readStage,
      commitStage,
      releaseStage,
    },
  } satisfies DynamoDBStateService;
});

/**
 * The DynamoDB store, with the operations `alchemy state migrate` moves
 * stages with.
 */
export interface DynamoDBStateService extends StateService {
  readonly migration: {
    readonly target: Effect.Effect<
      { table: string; bucket: string; region: string; legacy: LegacyLocation | undefined },
      StateStoreError
    >;
    readonly catalog: () => Effect.Effect<
      ReadonlyArray<{ stack: string; stage: string }>,
      StateStoreError
    >;
    readonly cataloged: (stack: string, stage: string) => Effect.Effect<boolean, StateStoreError>;
    readonly hold: (stack: string, stage: string) => Effect.Effect<void, StateStoreError>;
    readonly readStage: (
      stack: string,
      stage: string,
    ) => Effect.Effect<StageContents, StateStoreError>;
    readonly commitStage: (
      stack: string,
      stage: string,
      contents: StageContents,
      migratedFrom: string,
      beforeCommit?: Effect.Effect<void, StateStoreError>,
    ) => Effect.Effect<void, StateStoreError>;
    readonly releaseStage: (stack: string, stage: string) => Effect.Effect<void, StateStoreError>;
  };
}

/** The table's description, or `undefined` when it doesn't exist. */
const describeStateTable = (table: string) =>
  dynamodb.describeTable({ TableName: table }).pipe(
    Effect.map((result) => result.Table),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
  );

const validateKeySchema = (table: dynamodb.TableDescription) => {
  const keys = table.KeySchema ?? [];
  const hash = keys.find((key) => key.KeyType === "HASH")?.AttributeName;
  const range = keys.find((key) => key.KeyType === "RANGE")?.AttributeName;
  return hash === "PK" && range === "SK"
    ? Effect.void
    : Effect.fail(
        new StateStoreError({
          message: `DynamoDB state table '${table.TableName}' must have partition key PK and sort key SK (found ${hash ?? "none"} and ${range ?? "none"})`,
        }),
      );
};

class TableNotActive extends Data.TaggedError("TableNotActive") {}

const waitForTableActive = (table: string) =>
  dynamodb.describeTable({ TableName: table }).pipe(
    Effect.flatMap((result) =>
      result.Table?.TableStatus === "ACTIVE"
        ? Effect.succeed(result.Table)
        : Effect.fail(new TableNotActive()),
    ),
    Effect.retry({
      // A just-created table can briefly describe as missing.
      while: (error) =>
        error._tag === "TableNotActive" || error._tag === "ResourceNotFoundException",
      schedule: Schedule.spaced("1 second"),
      times: 60,
    }),
    Effect.catchTag("TableNotActive", () =>
      Effect.fail(
        new StateStoreError({ message: `DynamoDB state table '${table}' never became ACTIVE` }),
      ),
    ),
  );

/**
 * Observe-then-ensure the state table: create it if missing (tolerating
 * create races), wait for it to become ACTIVE, and enable point-in-time
 * recovery.
 */
const ensureStateTable = Effect.fn(function* (table: string) {
  const observed = yield* describeStateTable(table);
  if (observed === undefined) {
    yield* Effect.logInfo(`DynamoDB state store: creating table ${table}`);
    yield* dynamodb
      .createTable({
        TableName: table,
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      })
      // Another first caller is creating it.
      .pipe(Effect.catchTag("ResourceInUseException", () => Effect.void));
  } else {
    yield* validateKeySchema(observed);
  }
  yield* waitForTableActive(table);

  const backups = yield* dynamodb.describeContinuousBackups({ TableName: table });
  if (
    backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
      ?.PointInTimeRecoveryStatus !== "ENABLED"
  ) {
    yield* dynamodb
      .updateContinuousBackups({
        TableName: table,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      })
      .pipe(
        // Backups become available shortly after the table is ACTIVE.
        Effect.retry({
          while: (error) => error._tag === "ContinuousBackupsUnavailableException",
          schedule: Schedule.spaced("2 seconds"),
          times: 15,
        }),
      );
  }
});

/**
 * Create the state table, or converge an existing one: what first use of
 * {@link dynamoDBState} does.
 */
export const provisionStateTable = (table: string): Effect.Effect<void, StateStoreError, AwsDeps> =>
  ensureStateTable(table).pipe(Effect.mapError(toError));

/** Whether a state table exists. */
export const stateTableExists = (table: string) =>
  describeStateTable(table).pipe(Effect.map((observed) => observed !== undefined));
