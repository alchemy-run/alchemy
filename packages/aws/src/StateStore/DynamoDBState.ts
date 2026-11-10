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
import {
  makeSealingCodec,
  type SealingScope,
  StateEncryption,
} from "alchemy/State/StateEncryption";
import { checkStoreFormat, STATE_STORE_FORMAT } from "alchemy/State/StoreFormat";
import { recordStateStoreInit } from "alchemy/Telemetry/Metrics";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { AWSEnvironment } from "../Environment.ts";
import { bucketEncryptionMatches, syncBucketEncryption } from "../S3/Bucket.ts";
import { customerKeyArn, kmsKeyring, resolveStateKey, StateKmsKey } from "./Key.ts";
import {
  fenceLegacyStage,
  HELD_PREFIX,
  hasLegacyStage,
  type LegacyLocation,
  listLegacyStacks,
  listLegacyStages,
  normalizePrefix,
  readLegacyOutput,
  type StageContents,
} from "./LegacyLayout.ts";
import { type CatalogStatus, migrateToDynamoDB, ownsStage, rollbackToS3 } from "./Migration.ts";
import {
  createStateBucketName,
  provisionStateBucket,
  stateBucketEncryption,
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
   * secure defaults, with the table.
   *
   * @default `alchemy-state-overflow-<accountId>-<region>-an`
   */
  overflowBucketName?: string;
  /**
   * The S3 state store whose stages this store takes over. A stage that is
   * still there and not yet in DynamoDB is refused until `alchemy state
   * migrate` moves it; `false` skips the check, and the S3 access it needs.
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
/** Partition and sort key of the store's format record. */
const STORE = "STORE";
const FORMAT = "FORMAT";

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

/** S3's limit on the length of a bucket name. */
const MAX_BUCKET_NAME = 63;

/**
 * Build the default overflow bucket name, in the account-regional namespace.
 * A store name too long to fit is shortened, with a hash of the full name
 * keeping it unique.
 */
export const createOverflowBucketName = (accountId: string, region: string, name?: string) => {
  const suffix = `${accountId}-${region}-an`;
  const full = `alchemy-state-overflow-${name === undefined ? "" : `${name}-`}${suffix}`;
  if (name === undefined || full.length <= MAX_BUCKET_NAME) return full.toLowerCase();
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const room = MAX_BUCKET_NAME - `alchemy-state-overflow--${hash}-${suffix}`.length;
  return `alchemy-state-overflow-${name.slice(0, Math.max(0, room)).replace(/-+$/, "")}-${hash}-${suffix}`
    .replace("--", "-")
    .toLowerCase();
};

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
 * The table and overflow bucket are created on the first state operation
 * if they do not already exist, the table with deletion protection and
 * point-in-time recovery enabled.
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
      const context = yield* Effect.context<AwsDeps | AWSEnvironment | SecureRandom.SecureRandom>();

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

/** A stage lease this store holds. */
export interface HeldLease {
  readonly token: string;
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
): Effect.Effect<void, StateStoreError> =>
  Effect.gen(function* () {
    if (lastOkAt !== undefined && (yield* Clock.currentTimeMillis) - lastOkAt < ttlMs) {
      return;
    }
    yield* checkLive;
    lastOkAt = yield* Clock.currentTimeMillis;
  });

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
  const random = yield* SecureRandom.SecureRandom;
  const leaseScope = yield* Effect.scope;
  // Captured under `withoutSdkDebugLogs` (below), so every store call runs
  // with the raised floor: request payloads are state, and state holds
  // secrets.
  const context = yield* Effect.context<AwsDeps | AWSEnvironment>();
  const run = <A, E>(effect: Effect.Effect<A, E, AwsDeps>): Effect.Effect<A, StateStoreError> =>
    effect.pipe(Effect.provideContext(context), Effect.mapError(toError));

  const threshold = options.overflowThreshold ?? DEFAULT_OVERFLOW_THRESHOLD;
  // Only the stack's config describes a store with its own names, so
  // `--backend aws` can't bootstrap it.
  const configured = options.tableName !== undefined || options.overflowBucketName !== undefined;
  const label = "DynamoDB";

  // The table, overflow bucket and S3 store this store addresses.
  const names = yield* Effect.cached(
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
      return { table, bucket, region, legacy };
    }).pipe(Effect.provideContext(context), Effect.mapError(toError)),
  );

  // The KMS key of the AWS.stateEncryption() provided to the store, or else
  // the store's own; it encrypts the table and overflow bucket at rest.
  const encryption = yield* Effect.serviceOption(StateEncryption);
  const kmsKey = yield* Effect.serviceOption(StateKmsKey);
  if (Option.isSome(kmsKey)) yield* kmsKey.value.forStore(options.name);
  const storeKey = (table: string) =>
    Option.isSome(kmsKey)
      ? kmsKey.value.arn
      : resolveStateKey({
          name: options.name,
          store: { ...storeRef, label: `DynamoDB state table '${table}'` },
        });

  const provision = (table: string, bucket: string, region: string, keyArn: string) =>
    Effect.all([ensureStateTable(table, keyArn), provisionStateBucket(bucket, region, keyArn)], {
      concurrency: 2,
      discard: true,
    });

  const storeRef = {
    backend: DYNAMODB_STATE_BACKEND,
    flags: { name: options.name },
    configured,
  };

  /**
   * Move an existing table and overflow bucket to SSE-KMS under `keyArn`.
   * Outside CI only (or with `--yes`): the store works without it, and a
   * CI role may not be allowed to change the table.
   */
  const convergeAtRest = Effect.fn(function* (
    table: string,
    observed: dynamodb.TableDescription,
    bucket: string,
    keyArn: string,
    bucketCreated: boolean,
  ) {
    const encryption = stateBucketEncryption(keyArn);
    const [tableEncrypted, bucketEncrypted] = yield* Effect.all(
      [
        Effect.succeed(tableUsesKey(observed, keyArn)),
        // A bucket this run just created already has the key.
        bucketCreated ? Effect.succeed(true) : bucketEncryptionMatches(bucket, encryption),
      ],
      { concurrency: 2 },
    );
    if (tableEncrypted && bucketEncrypted) return;
    yield* Provisioning.convergeSettings(
      {
        ...storeRef,
        label: `DynamoDB state table '${table}'`,
        problem: `is not encrypted at rest with the state store's KMS key`,
      },
      Effect.all(
        [
          tableEncrypted ? Effect.void : encryptTable(table, observed, keyArn),
          bucketEncrypted ? Effect.void : syncBucketEncryption(bucket, encryption),
        ],
        { concurrency: 2, discard: true },
      ),
    );
  });

  // Ensure the table and overflow bucket exist on the first operation, so a
  // missing one fails the run before it changes anything.
  /**
   * Check the store's format record, and write this version's for a store
   * it hasn't used yet. A newer format is refused before anything changes.
   */
  const ensureFormat = Effect.fn(function* (table: string) {
    const key = { PK: S(STORE), SK: S(FORMAT) };
    const existing = yield* dynamodb.getItem({ TableName: table, Key: key, ConsistentRead: true });
    const observed =
      existing.Item?.format?.N === undefined ? undefined : Number(existing.Item.format.N);
    yield* checkStoreFormat(`DynamoDB state table '${table}'`, observed);
    if (observed === STATE_STORE_FORMAT) return;
    yield* dynamodb
      .putItem({
        TableName: table,
        Item: { ...key, format: N(STATE_STORE_FORMAT) },
        ConditionExpression: "attribute_not_exists(PK) OR #format < :format",
        ExpressionAttributeNames: { "#format": "format" },
        ExpressionAttributeValues: { ":format": N(STATE_STORE_FORMAT) },
      })
      // Another first caller wrote it.
      .pipe(Effect.catchTag("ConditionalCheckFailedException", () => Effect.void));
  });

  const target = yield* Effect.cached(
    Effect.gen(function* () {
      const { table, bucket, region, legacy } = yield* names;
      const [observed, bucketExists] = yield* Effect.all(
        [describeStateTable(table), stateBucketExists(bucket)],
        { concurrency: 2 },
      );
      // A table an earlier version created under a customer-managed key
      // (its `kmsKeyId` option) keeps that key, unless a layer picks one.
      const existingKey =
        Option.isNone(kmsKey) &&
        observed?.SSEDescription?.SSEType === "KMS" &&
        observed.SSEDescription.KMSMasterKeyArn !== undefined
          ? yield* customerKeyArn(observed.SSEDescription.KMSMasterKeyArn)
          : undefined;
      const keyArn = existingKey ?? (yield* storeKey(table));
      if (observed === undefined) {
        yield* Provisioning.deployMissing(
          { ...storeRef, label: `DynamoDB state table '${table}'` },
          provision(table, bucket, region, keyArn),
        );
      } else {
        yield* validateKeySchema(observed);
        if (observed.TableStatus !== "ACTIVE") yield* waitForTableActive(table);
        if (!bucketExists) {
          yield* Provisioning.deployMissing(
            { ...storeRef, label: `DynamoDB state overflow bucket '${bucket}'` },
            provisionStateBucket(bucket, region, keyArn),
          );
        }
        yield* convergeAtRest(table, observed, bucket, keyArn, !bucketExists);
      }
      yield* ensureFormat(table);
      return { table, bucket, region, legacy, keyArn };
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
            ? Effect.void
            : result.Body.pipe(Stream.decodeText, Stream.mkString),
        ),
        Effect.catchTag("NoSuchKey", () => Effect.void),
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

  // Secrets are encrypted with the StateEncryption provided to the store,
  // and otherwise with data keys from the store's KMS key.
  const codec = makeSealingCodec(
    Option.getOrElse(encryption, () =>
      kmsKeyring(target.pipe(Effect.map(({ keyArn }) => keyArn)), run),
    ),
  );

  const parse = <T>(scope: SealingScope, text: string, what: string) =>
    codec.decode<T>(scope, text, `DynamoDB state ${what}`);

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
      // A fresh key per write, so the committed item's object is never
      // overwritten in place.
      const suffix = yield* random.uuidV4();
      const ref = `${blobPrefix(key.stack, key.stage)}${encodeURIComponent(key.SK)}-${suffix}.json`;
      yield* use(({ bucket }) =>
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

  const catalogKey = (stack: string, stage: string) => ({
    PK: S(CATALOG),
    SK: S(catalogSk(stack, stage)),
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

  /** Take the stage's lease, held until `scope` closes. */
  const acquireLease = Effect.fn(function* (stack: string, stage: string, scope: Scope.Scope) {
    const token = yield* random.uuidV4();
    const now = yield* Clock.currentTimeMillis;
    // Take the lease when nobody holds it or the holder let it expire.
    const acquired = yield* putLease(stack, stage, token, now + LEASE_TTL_MS, {
      ConditionExpression: "attribute_not_exists(PK) OR #expiresAt <= :now",
      ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
      ExpressionAttributeValues: { ":now": N(now) },
    });
    if (!acquired) return yield* heldError(stack, stage);

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
        if (cursor.lost) return yield* lostError(stack, stage);
        const existing = yield* use(({ table }) =>
          dynamodb.getItem({
            TableName: table,
            Key: leaseKey(stack, stage),
            ConsistentRead: true,
          }),
        );
        if (str(existing.Item, "token") !== token) {
          cursor.lost = true;
          return yield* lostError(stack, stage);
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
            return yield* lostError(stack, stage);
          }
        }
      }),
    );

    // Stop the refresh before releasing, so a refresh cannot land after
    // the lease has been released.
    yield* Scope.addFinalizer(
      scope,
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
      Effect.forkIn(scope),
    );

    // The conditional put just proved the lease, so the first check is free.
    return {
      token,
      checkLive: amortizeCheck(verify, LEASE_CHECK_TTL_MS, yield* Clock.currentTimeMillis),
    } satisfies HeldLease;
  });

  /**
   * Write one catalog item in a transaction with a check that `lease` is
   * still the stage's. A holder that stalled past its lease, and lost it to
   * another deploy, can't move the stage in or out of the catalog.
   */
  const writeUnderLease = (
    stack: string,
    stage: string,
    lease: HeldLease,
    write: (table: string) => dynamodb.TransactWriteItem,
  ) =>
    use(({ table }) =>
      dynamodb
        .transactWriteItems({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: table,
                Key: leaseKey(stack, stage),
                ConditionExpression: "#token = :token",
                ExpressionAttributeNames: { "#token": "token" },
                ExpressionAttributeValues: { ":token": S(lease.token) },
              },
            },
            write(table),
          ],
        })
        .pipe(
          // A refresh of the lease landed during the transaction.
          Effect.retry({
            while: (error) =>
              error._tag === "TransactionCanceledException" &&
              cancellationCodes(error).includes("TransactionConflict"),
            schedule: Schedule.exponential("100 millis"),
            times: 5,
          }),
          Effect.catchTag("TransactionCanceledException", (error) =>
            Effect.fail(
              cancellationCodes(error)[0] === "ConditionalCheckFailed"
                ? lostError(stack, stage)
                : error,
            ),
          ),
        ),
    ).pipe(Effect.asVoid);

  const migrateCommand = (stack: string, stage: string) =>
    `alchemy state migrate --stack ${stack} --stage ${stage}`;

  /** The stage's catalog status; `undefined` when DynamoDB doesn't know it. */
  const catalogStatus = (stack: string, stage: string) =>
    use(({ table }) =>
      dynamodb.getItem({
        TableName: table,
        Key: catalogKey(stack, stage),
        ConsistentRead: true,
      }),
    ).pipe(Effect.map((result) => statusOf(result.Item)));

  /**
   * Refuse a stage the S3 store still has and DynamoDB doesn't own: its
   * state has not moved, and serving an empty stage would redeploy it.
   */
  const refuseUnmigrated = Effect.fn(function* (stack: string, stage: string) {
    const status = yield* catalogStatus(stack, stage);
    const { legacy } = yield* names;
    if (legacy === undefined || ownsStage(status)) return status;
    if (!(yield* use(() => hasLegacyStage(legacy, stack, stage)))) return status;
    const command = migrateCommand(stack, stage);
    return yield* new StateStoreError({
      message: `Stage '${stack}/${stage}' is still in the S3 state store (s3://${legacy.bucket}/${legacy.prefix}). Run '${command}' to move it to DynamoDB.`,
      requires: { action: "upgrade", command },
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
    const [items, status] = yield* Effect.all(
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
    // Rewrite records the codec calls stale: seal secrets written before the
    // store encrypted them, or open them while encryption is being turned
    // off. A stage converts when it loads, not when each resource changes.
    // The caller holds the stage's lease.
    const scope = { stack, stage };
    const resealed = yield* Effect.forEach(
      records,
      ([fqn, record]) =>
        codec.stale(record.text)
          ? Effect.gen(function* () {
              const value = yield* parse<unknown>(scope, record.text, `record '${fqn}'`);
              const text = yield* codec.encode(scope, value);
              yield* putPayload(
                { PK: stagePk(stack, stage), SK: yield* recordSk(fqn), stack, stage },
                text,
                { fqn: S(fqn) },
              );
              return [fqn, { text }] as const;
            })
          : Effect.succeed([fqn, record] as const),
      { concurrency: 16 },
    );
    return { records: new Map<string, StoredRecord>(resealed), status } satisfies Snapshot;
  });

  // One lease per (stack, stage), taken on the first operation and held
  // for the store's lifetime. The snapshot is cached apart from the lease
  // so a failed load retries without re-taking the lease this store holds.
  const leases = keyedCache<HeldLease>();
  const snapshots = keyedCache<Snapshot>();
  // Stages this store has entered in the catalog.
  const registered = keyedCache<void>();

  const guarded = <A>(
    request: { stack: string; stage: string },
    op: (snapshot: Snapshot, lease: HeldLease) => Effect.Effect<A, StateStoreError>,
  ): Effect.Effect<A, StateStoreError> => {
    const key = `${request.stack}/${request.stage}`;
    return leases.get(key, acquireLease(request.stack, request.stage, leaseScope)).pipe(
      Effect.tap((lease) => lease.checkLive),
      Effect.flatMap((lease) =>
        snapshots
          .get(key, loadStage(request.stack, request.stage))
          .pipe(Effect.flatMap((snapshot) => op(snapshot, lease))),
      ),
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
  const register = (stack: string, stage: string, snapshot: Snapshot, lease: HeldLease) =>
    registered.get(
      `${stack}/${stage}`,
      Effect.gen(function* () {
        const { legacy, table } = yield* names;
        // A stage new to DynamoDB is fenced in the S3 store too, so a
        // teammate still on the S3 store fails at its lock instead of
        // deploying the stage a second time.
        if (
          legacy !== undefined &&
          (snapshot.status === undefined || snapshot.status === "rolled-back")
        ) {
          const fence = yield* use(() => fenceLegacyStage(legacy, stack, stage, table));
          if (!fence.fenced) {
            return yield* new StateStoreError({
              message: `${HELD_PREFIX} the S3 state lock '${stack}/${stage}': a deploy on the S3 state store is creating this stage`,
            });
          }
        }
        // Keep the entry's migration record; a destroyed stage is live again.
        yield* writeUnderLease(stack, stage, lease, (table) => ({
          Update: {
            TableName: table,
            Key: catalogKey(stack, stage),
            UpdateExpression: "SET #stack = :stack, #stage = :stage REMOVE #status",
            ExpressionAttributeNames: { "#stack": "stack", "#stage": "stage", "#status": "status" },
            ExpressionAttributeValues: { ":stack": S(stack), ":stage": S(stage) },
          },
        }));
        snapshot.status = "active";
      }),
    );

  /** Every cataloged stage, of one stack or all of them, in one query. */
  const catalog = (stack?: string) =>
    queryPartition(CATALOG, stack === undefined ? "STAGE#" : catalogPrefix(stack)).pipe(
      Effect.map((items) =>
        items.flatMap((item) => {
          const stack = str(item, "stack");
          const stage = str(item, "stage");
          const status = statusOf(item);
          return stack === undefined || stage === undefined || status === undefined
            ? []
            : [{ stack, stage, status }];
        }),
      ),
    );

  const stageKey = (stack: string, stage: string) => `${stack}\u0000${stage}`;

  /** Stages of a stack, in DynamoDB or still in the S3 store. */
  const listStages = (stack: string) =>
    Effect.all(
      [
        catalog(stack),
        names.pipe(
          Effect.flatMap(({ legacy }) =>
            legacy === undefined ? Effect.succeed([]) : use(() => listLegacyStages(legacy, stack)),
          ),
        ),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([entries, legacy]) => {
        const owned = new Set(entries.filter((e) => ownsStage(e.status)).map((e) => e.stage));
        return Array.from(
          new Set([
            ...entries.filter((entry) => entry.status === "active").map((entry) => entry.stage),
            ...legacy.filter((stage) => !owned.has(stage)),
          ]),
        );
      }),
    );

  /** Delete a stage's records, output and overflow objects. */
  const deleteStageItems = Effect.fn(function* (stack: string, stage: string) {
    const items = (yield* queryPartition(stagePk(stack, stage), undefined, "PK, SK, #ref")).filter(
      // Leave the lease. Releasing it here would open the stage before
      // this delete finishes, and the store still holds the lock.
      (item) => str(item, "SK") !== LEASE,
    );
    yield* deleteItems(items.map((item) => ({ PK: str(item, "PK")!, SK: str(item, "SK")! })));
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
  });

  /** Delete a stage. Its catalog entry stays as a tombstone while an S3 copy may exist. */
  const deleteStage = (stack: string, stage: string) =>
    guarded({ stack, stage }, (snapshot, lease) =>
      Effect.gen(function* () {
        yield* deleteStageItems(stack, stage);
        snapshot.records.clear();
        if (snapshot.status !== undefined) {
          const { legacy } = yield* names;
          // With an S3 store behind it, a deleted entry would read as a
          // stage that never moved, and bring its pre-migration copy back.
          yield* writeUnderLease(stack, stage, lease, (table) =>
            legacy === undefined
              ? { Delete: { TableName: table, Key: catalogKey(stack, stage) } }
              : {
                  Update: {
                    TableName: table,
                    Key: catalogKey(stack, stage),
                    UpdateExpression: "SET #stack = :stack, #stage = :stage, #status = :destroyed",
                    ExpressionAttributeNames: {
                      "#stack": "stack",
                      "#stage": "stage",
                      "#status": "status",
                    },
                    ExpressionAttributeValues: {
                      ":stack": S(stack),
                      ":stage": S(stage),
                      ":destroyed": S("destroyed"),
                    },
                  },
                },
          );
          snapshot.status = legacy === undefined ? undefined : "destroyed";
        }
        // A later write to the stage enters it in the catalog again.
        registered.entries.delete(`${stack}/${stage}`);
      }),
    );

  const state: StateService = {
    id: "dynamodb",
    getVersion: () => Effect.succeed(STATE_STORE_VERSION),
    // A stack is listed while it has a live stage in DynamoDB, or a stage
    // the S3 store still has.
    listStacks: () =>
      verifyHeldLeases.pipe(
        Effect.andThen(Effect.all([catalog(), names], { concurrency: 2 })),
        Effect.flatMap(([entries, { legacy }]) => {
          const owned = new Set(
            entries.filter((e) => ownsStage(e.status)).map((e) => stageKey(e.stack, e.stage)),
          );
          const live = entries.filter((entry) => entry.status === "active").map((e) => e.stack);
          if (legacy === undefined) return Effect.succeed(Array.from(new Set(live)));
          return use(() =>
            listLegacyStacks(legacy).pipe(
              Effect.flatMap((stacks) =>
                Effect.forEach(
                  stacks,
                  (stack) =>
                    listLegacyStages(legacy, stack).pipe(
                      Effect.map((stages) =>
                        stages.some((stage) => !owned.has(stageKey(stack, stage))) ? [stack] : [],
                      ),
                    ),
                  { concurrency: 8 },
                ),
              ),
            ),
          ).pipe(
            Effect.map((legacyStacks) => Array.from(new Set([...live, ...legacyStacks.flat()]))),
          );
        }),
      ),
    listStages: (stack) => verifyHeldLeases.pipe(Effect.andThen(listStages(stack))),
    get: (request) =>
      guarded(request, ({ records }) => {
        const record = records.get(request.fqn);
        return record === undefined
          ? Effect.undefined
          : parse<PersistedState>(request, record.text, `record '${request.fqn}'`);
      }),
    getReplacedResources: (request) =>
      guarded(request, ({ records }) =>
        Effect.forEach(Array.from(records), ([fqn, record]) =>
          parse<PersistedState>(request, record.text, `record '${fqn}'`),
        ).pipe(Effect.map((values) => values.filter((value) => value.status === "replaced"))),
      ) as ReturnType<StateService["getReplacedResources"]>,
    set: (request) =>
      guarded(request, (snapshot, lease) =>
        Effect.gen(function* () {
          yield* register(request.stack, request.stage, snapshot, lease);
          const text = yield* codec.encode(request, request.value);
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
          snapshot.records.set(request.fqn, { text });
          return request.value;
        }),
      ),
    delete: (request) =>
      guarded(request, ({ records }) =>
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
    list: (request) =>
      guarded(request, ({ records }) => Effect.succeed(Array.from(records.keys()))),
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
        return yield* parse<unknown>(request, yield* itemText(result.Item), "stack output");
      }
      // A stage that hasn't moved yet keeps its output in the S3 store.
      // Reading it takes no lease, so a reference to it still resolves.
      const { legacy } = yield* names;
      if (legacy === undefined) return undefined;
      if (ownsStage(yield* catalogStatus(request.stack, request.stage))) return undefined;
      return yield* use(() => readLegacyOutput(legacy, request.stack, request.stage, codec));
    }),
    setOutput: (request) =>
      guarded(request, (snapshot, lease) =>
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
          yield* register(request.stack, request.stage, snapshot, lease);
          yield* putPayload(
            {
              PK: stagePk(request.stack, request.stage),
              SK: OUTPUT,
              stack: request.stack,
              stage: request.stage,
            },
            yield* codec.encode(request, request.value),
            {},
          );
          return request.value;
        }),
      ),
  };

  /**
   * Run `body` holding the stage's lease, released as soon as it finishes
   * rather than when the store closes.
   */
  const exclusive = <A, R>(
    stack: string,
    stage: string,
    body: (lease: HeldLease) => Effect.Effect<A, StateStoreError, R>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const key = `${stack}/${stage}`;
        const scope = yield* Effect.scope;
        const lease = yield* acquireLease(stack, stage, scope);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            snapshots.entries.delete(key);
            registered.entries.delete(key);
          }),
        );
        return yield* body(lease);
      }),
    );

  /**
   * Make the stage hold exactly `contents`, check it does, and enter it in
   * the catalog: the commit that makes DynamoDB the stage's store.
   */
  const commitStage = Effect.fn(function* (
    stack: string,
    stage: string,
    lease: HeldLease,
    contents: StageContents,
    migratedFrom: string,
    beforeCommit: Effect.Effect<void, StateStoreError> = Effect.void,
  ) {
    yield* lease.checkLive;
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
    const migratedAt = DateTime.formatIso(yield* DateTime.now);
    yield* writeUnderLease(stack, stage, lease, (table) => ({
      Put: {
        TableName: table,
        Item: {
          ...catalogKey(stack, stage),
          stack: S(stack),
          stage: S(stage),
          migratedFrom: S(migratedFrom),
          migratedAt: S(migratedAt),
        },
      },
    }));
  });

  /** Mark the stage as moved back: the S3 store is its store again. */
  const markRolledBack = (stack: string, stage: string, lease: HeldLease) =>
    writeUnderLease(stack, stage, lease, (table) => ({
      Update: {
        TableName: table,
        Key: catalogKey(stack, stage),
        UpdateExpression: "SET #status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": S("rolled-back") },
      },
    }));

  const service: DynamoDBStateService = {
    ...state,
    migrate: (request) =>
      (request.rollback
        ? rollbackToS3(service, request)
        : migrateToDynamoDB(service, request)
      ).pipe(Effect.provideContext(context)),
    migration: {
      names,
      provision: names.pipe(
        Effect.tap((resolved) =>
          storeKey(resolved.table).pipe(
            Effect.flatMap((keyArn) =>
              provision(resolved.table, resolved.bucket, resolved.region, keyArn),
            ),
            Effect.provideContext(context),
            Effect.mapError(toError),
          ),
        ),
      ),
      catalog: () => catalog(),
      status: catalogStatus,
      exclusive,
      readStage,
      openStage: (stack, stage, contents) =>
        Effect.gen(function* () {
          const scope = { stack, stage };
          const records = yield* Effect.forEach(
            Array.from(contents.records),
            ([fqn, text]) =>
              codec.open(scope, text).pipe(Effect.map((open) => [fqn, open] as const)),
            { concurrency: 16 },
          );
          return {
            records: new Map(records),
            output:
              contents.output === undefined ? undefined : yield* codec.open(scope, contents.output),
          } satisfies StageContents;
        }),
      sealStage: (stack, stage, contents) =>
        Effect.gen(function* () {
          const scope = { stack, stage };
          const seal = (text: string, what: string) =>
            codec.stale(text)
              ? parse<unknown>(scope, text, what).pipe(
                  Effect.flatMap((value) => codec.encode(scope, value)),
                )
              : Effect.succeed(text);
          const records = yield* Effect.forEach(
            Array.from(contents.records),
            ([fqn, text]) =>
              seal(text, `record '${fqn}'`).pipe(Effect.map((sealed) => [fqn, sealed] as const)),
            { concurrency: 16 },
          );
          return {
            records: new Map(records),
            output:
              contents.output === undefined
                ? undefined
                : yield* seal(contents.output, "stack output"),
          } satisfies StageContents;
        }),
      commitStage,
      markRolledBack,
      deleteStageItems: (stack, stage, lease) =>
        lease.checkLive.pipe(Effect.andThen(deleteStageItems(stack, stage))),
    },
  };
  return service;
});

/** Why each item of a cancelled transaction failed, in request order. */
const cancellationCodes = (error: dynamodb.TransactionCanceledException) =>
  // The generated schema leaves the reason list untyped.
  ((error.CancellationReasons ?? []) as ReadonlyArray<dynamodb.CancellationReason>).map(
    (reason) => reason.Code,
  );

/** A stage's snapshot: its records and its catalog status when loaded. */
interface Snapshot {
  readonly records: Map<string, StoredRecord>;
  status: CatalogStatus | undefined;
}

const statusOf = (item: Item | undefined): CatalogStatus | undefined =>
  item === undefined ? undefined : ((str(item, "status") as CatalogStatus | undefined) ?? "active");

/**
 * The DynamoDB store, with the operations `alchemy state migrate` moves
 * stages with.
 */
export interface DynamoDBStateService extends StateService {
  readonly migration: {
    /** The table, overflow bucket and S3 store this store addresses. */
    readonly names: Effect.Effect<
      { table: string; bucket: string; region: string; legacy: LegacyLocation | undefined },
      StateStoreError
    >;
    /** {@link names}, after creating the table, overflow bucket and key if missing. */
    readonly provision: Effect.Effect<
      { table: string; bucket: string; region: string; legacy: LegacyLocation | undefined },
      StateStoreError
    >;
    readonly catalog: () => Effect.Effect<
      ReadonlyArray<{ stack: string; stage: string; status: CatalogStatus }>,
      StateStoreError
    >;
    readonly status: (
      stack: string,
      stage: string,
    ) => Effect.Effect<CatalogStatus | undefined, StateStoreError>;
    readonly exclusive: <A, R>(
      stack: string,
      stage: string,
      body: (lease: HeldLease) => Effect.Effect<A, StateStoreError, R>,
    ) => Effect.Effect<A, StateStoreError, Exclude<R, Scope.Scope>>;
    readonly readStage: (
      stack: string,
      stage: string,
    ) => Effect.Effect<StageContents, StateStoreError>;
    /**
     * The stage's contents with every sealed secret opened, for an S3 store
     * written for a version of alchemy from before sealing.
     */
    readonly openStage: (
      stack: string,
      stage: string,
      contents: StageContents,
    ) => Effect.Effect<StageContents, StateStoreError>;
    /**
     * The stage's contents with its secrets sealed as this store seals them,
     * for a stage moving in from an S3 store that kept them in plaintext.
     */
    readonly sealStage: (
      stack: string,
      stage: string,
      contents: StageContents,
    ) => Effect.Effect<StageContents, StateStoreError>;
    readonly commitStage: (
      stack: string,
      stage: string,
      lease: HeldLease,
      contents: StageContents,
      migratedFrom: string,
      beforeCommit?: Effect.Effect<void, StateStoreError>,
    ) => Effect.Effect<void, StateStoreError>;
    readonly markRolledBack: (
      stack: string,
      stage: string,
      lease: HeldLease,
    ) => Effect.Effect<void, StateStoreError>;
    readonly deleteStageItems: (
      stack: string,
      stage: string,
      lease: HeldLease,
    ) => Effect.Effect<void, StateStoreError>;
  };
}

/** The table's description, or `undefined` when it doesn't exist. */
const describeStateTable = (table: string) =>
  dynamodb.describeTable({ TableName: table }).pipe(
    Effect.map((result) => result.Table),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
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

/** Whether the table is encrypted at rest with `keyArn`. */
const tableUsesKey = (table: dynamodb.TableDescription, keyArn: string) =>
  table.SSEDescription?.SSEType === "KMS" && table.SSEDescription.KMSMasterKeyArn === keyArn;

/**
 * Move a table to SSE-KMS under `keyArn`. DynamoDB re-encrypts it in the
 * background, and it keeps serving reads and writes meanwhile.
 */
const encryptTable = (table: string, observed: dynamodb.TableDescription, keyArn: string) =>
  // Already moving to a key. The move takes minutes, and DynamoDB reports
  // no key until it finishes.
  observed.SSEDescription?.Status === "UPDATING"
    ? Effect.void
    : dynamodb
        .updateTable({
          TableName: table,
          SSESpecification: { Enabled: true, SSEType: "KMS", KMSMasterKeyId: keyArn },
        })
        .pipe(
          Effect.tap(() =>
            Effect.logInfo(`DynamoDB state store: encrypting table ${table} with ${keyArn}`),
          ),
          Effect.asVoid,
          // Another first caller is updating it.
          Effect.catchTag("ResourceInUseException", () => Effect.void),
        );

/**
 * Observe-then-ensure the state table: create it if missing (tolerating
 * create races), with deletion protection and SSE-KMS under `keyArn`; move
 * an existing table to that key; wait for it to become ACTIVE, and enable
 * point-in-time recovery.
 */
const ensureStateTable = Effect.fn(function* (table: string, keyArn: string) {
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
        // The table holds the state of every stack on the account.
        DeletionProtectionEnabled: true,
        SSESpecification: { Enabled: true, SSEType: "KMS", KMSMasterKeyId: keyArn },
      })
      // Another first caller is creating it.
      .pipe(Effect.catchTag("ResourceInUseException", () => Effect.void));
  } else {
    yield* validateKeySchema(observed);
  }
  const active = yield* waitForTableActive(table);
  if (!tableUsesKey(active, keyArn)) yield* encryptTable(table, active, keyArn);

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
export const provisionStateTable = (
  table: string,
  keyArn: string,
): Effect.Effect<void, StateStoreError, AwsDeps> =>
  ensureStateTable(table, keyArn).pipe(Effect.mapError(toError));

/** Whether a state table exists. */
export const stateTableExists = (table: string) =>
  describeStateTable(table).pipe(Effect.map((observed) => observed !== undefined));
