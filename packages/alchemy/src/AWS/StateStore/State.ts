import * as crypto from "node:crypto";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { CredentialsStoreLive } from "../../Auth/Credentials.ts";
import { decodeFqn, encodeFqn } from "../../FQN.ts";
import { STATE_STORE_VERSION } from "../../State/HttpStateApi.ts";
import {
  State,
  StateStoreError,
  type PersistedState,
  type StateService,
} from "../../State/State.ts";
import { encodeState, reviveState } from "../../State/StateEncoding.ts";
import { recordStateStoreInit } from "../../Telemetry/Metrics.ts";
import { AwsAuth } from "../AuthProvider.ts";
import * as AwsCredentials from "../Credentials.ts";
import * as Endpoint from "../Endpoint.ts";
import { AWSEnvironment, providedOrDefault } from "../Environment.ts";
import * as AwsRegion from "../Region.ts";
import { syncBucketEncryption, type BucketEncryption } from "../S3/Bucket.ts";

/**
 * The bookkeeping object that stores a stack's resolved output. Lives
 * alongside the resource objects under the same stage prefix, so it
 * must be filtered out of `list` results before FQN decoding.
 */
const OUTPUT_FILE = "__stack_output__.json";

/**
 * Per `(stack, stage)` lease. Filtered out of `list` the same way as
 * {@link OUTPUT_FILE}. A delete of the stage leaves it in place so the
 * lock outlives the objects it was guarding; the store releases it on close.
 */
const LEASE_FILE = "__lease__.json";

/** How long a lease stays valid without a refresh. */
const LEASE_TTL_MS = 60_000;

/** How long a passing lease check is trusted. A failure is never cached. */
const LEASE_CHECK_TTL_MS = 5_000;

/** Maximum number of keys S3 accepts in a single DeleteObjects call. */
const DELETE_BATCH_SIZE = 1000;

interface LeaseRecord {
  readonly token: string;
  readonly expiresAt: number;
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
): Effect.Effect<void, StateStoreError> => {
  let lastOkAt: number | undefined;
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

export interface S3StateOptions {
  /**
   * Name of the S3 bucket that holds the state objects. The bucket is
   * created on first use if it does not exist.
   *
   * The bucket is created in the account-regional namespace, so custom
   * names must follow the `<prefix>-<accountId>-<region>-an` convention.
   *
   * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html#account-regional-gp-buckets
   * @default `alchemy-state-{accountId}-{region}-an`
   */
  bucketName?: string;
  /**
   * Key prefix within the bucket under which all state objects are
   * stored, e.g. `"alchemy"`. A trailing `/` is appended automatically.
   *
   * @default "" (bucket root)
   */
  prefix?: string;
  /**
   * Default encryption enforced on every fresh state-service initialization.
   * Omission restores AES256, no KMS key, bucket keys disabled, and no blocked
   * encryption types. Set `blockedEncryptionTypes: ["SSE-C"]` to block
   * customer-provided keys. Existing encrypted state objects are not rewritten.
   *
   * @default `{ sseAlgorithm: "AES256", bucketKeyEnabled: false, blockedEncryptionTypes: [] }`
   */
  encryption?: BucketEncryption;
}

/** Context required by the distilled S3 operations. */
type S3Deps = Credentials | HttpClient | Region;

/**
 * Run with Debug and Trace records switched off.
 *
 * The AWS client logs every request payload and parsed response at Debug. For
 * this store those are the serialized state objects, whose values include
 * secrets Alchemy generated and keeps, so a Debug floor inherited from where
 * the store is built (the CLI's run log sets one) must not reach them. Floors
 * already stricter than Info are left alone.
 */
const withoutSdkDebugLogs = Effect.updateService(References.MinimumLogLevel, (level) =>
  LogLevel.isLessThan(level, "Info") ? "Info" : level,
);

/**
 * State store backed by an AWS S3 bucket.
 *
 * Stack state is persisted as JSON objects in an account-regional S3
 * bucket, laid out exactly like the local state store's file tree with
 * the bucket (plus optional `prefix`) taking the place of the
 * `.alchemy/state` directory:
 *
 * ```
 * s3://{bucket}/{prefix}{stack}/{stage}/{fqn}.json
 * s3://{bucket}/{prefix}{stack}/{stage}/__stack_output__.json
 * s3://{bucket}/{prefix}{stack}/{stage}/__lease__.json
 * ```
 *
 * Concurrent deploys of one stack and stage share an `__lease__.json`
 * object written with `If-None-Match` / `If-Match`. The second deploy
 * fails immediately instead of mixing rows. The holder refreshes the
 * lease until the store closes. A killed process stops refreshing, the
 * lease expires, and the next deploy can take it.
 *
 * The bucket is created lazily on the first state operation if it does
 * not already exist — nothing touches AWS credentials at layer
 * construction time.
 *
 *
 * ### Using the S3 State Store
 * Pass `AWS.state()` as the `state` option of a Stack. By default the
 * state is stored in an account-regional bucket named
 * `alchemy-state-{accountId}-{region}-an`.
 *
 * **Example:** Default bucket
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
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
 * **Example:** Custom bucket and key prefix
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers(),
 *     state: AWS.state({
 *       bucketName: "my-company-state",
 *       prefix: "alchemy",
 *       encryption: {
 *         sseAlgorithm: "aws:kms",
 *         kmsMasterKeyId: "alias/alchemy-state",
 *       },
 *     }),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * ### Supplying the AWS Environment
 * The store resolves its account, region and credentials from the configured
 * profile, CI credentials or the ambient AWS environment. Provide an
 * `AWSEnvironment` to use another credential source; provide the same layer
 * to `AWS.providers()` so the state bucket and every resource share it.
 *
 * **Example:** Deploy-role credentials shared with the providers
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers().pipe(Layer.provide(environment)),
 *     state: AWS.state({ bucketName: "my-company-state" }).pipe(Layer.provide(environment)),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * ### Managing SSE-C Restrictions
 * **Example:** Block customer-provided encryption keys on the state bucket
 * ```typescript
 * const stateStore = AWS.state({
 *   encryption: {
 *     sseAlgorithm: "AES256",
 *     blockedEncryptionTypes: ["SSE-C"],
 *   },
 * });
 * ```
 *
 * Omitted `blockedEncryptionTypes` is equivalent to `[]`: no encryption types
 * are blocked, so SSE-C writes are permitted via AWS's `NONE` value. Removing
 * an explicit block clears it. Omitting `encryption` restores AES256, no KMS
 * key, disabled bucket keys, and no encryption restrictions. Existing objects
 * are not rewritten.
 *
 * @resource
 */
export const state = (options: S3StateOptions = {}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<S3Deps | AWSEnvironment>();

      // Bind the lease to this layer's scope. The cached effect runs on
      // the first state operation, which may sit in a shorter scope.
      const make = Scope.provide(makeS3State(options), scope).pipe(
        recordStateStoreInit,
        Effect.orDie,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  ).pipe(
    // Fresh per call: these derive from the environment below, and shared
    // (memoized) instances built for another environment in the same run
    // would shadow an `AWSEnvironment` provided to this layer.
    Layer.provideMerge(Layer.fresh(AwsRegion.fromEnvironment)),
    Layer.provideMerge(Layer.fresh(AwsCredentials.fromEnvironment)),
    Layer.provideMerge(Layer.fresh(Endpoint.fromEnvironment)),
    Layer.provideMerge(providedOrDefault()),
    Layer.provideMerge(AwsAuth),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );

/**
 * Construct an S3-backed {@link StateService}.
 *
 * Construction itself never touches AWS — environment resolution and
 * the ensure-bucket-exists check are deferred into a cached Effect
 * that runs once, on the first state operation.
 */
export const makeS3State = (options: S3StateOptions = {}) =>
  Effect.gen(function* () {
    // Callers that need the lease to outlive the first operation (the
    // `state()` layer) bind this effect to that scope with `Scope.provide`.
    const leaseScope = yield* Effect.scope;
    // Captured under `withoutSdkDebugLogs` (below), so every store call runs
    // with the raised floor.
    const context = yield* Effect.context<S3Deps | AWSEnvironment>();

    const prefix = options.prefix ? `${options.prefix.replace(/\/+$/, "")}/` : "";

    const toError = (cause: unknown) =>
      new StateStoreError({
        message: cause instanceof Error ? cause.message : `S3 state store error: ${String(cause)}`,
        cause: cause instanceof Error ? cause : undefined,
      });

    // Anything that touches AWS credentials must NOT run at layer
    // construction time. Resolving the environment (account/region),
    // deriving the bucket name, and ensuring the bucket exists are all
    // deferred into this cached Effect: `Effect.cached` memoizes the
    // result and locks concurrent first callers onto a single in-flight
    // run, so the bucket is ensured exactly once — lazily, on first use
    // of the state store.
    const bucket = yield* Effect.cached(
      Effect.gen(function* () {
        const { accountId, region } = yield* AWSEnvironment.current;
        const bucketName = options.bucketName ?? createStateBucketName(accountId, region);
        yield* ensureStateBucket(bucketName, region, options);
        return bucketName;
      }).pipe(Effect.provideContext(context), Effect.mapError(toError)),
    );

    // Close over the captured context so every StateService method is
    // self-contained (`R = never`), matching the StateService contract.
    const run = <A, E>(
      f: (bucket: string) => Effect.Effect<A, E, S3Deps>,
    ): Effect.Effect<A, StateStoreError> =>
      bucket.pipe(
        Effect.flatMap((bucket) =>
          f(bucket).pipe(Effect.provideContext(context), Effect.mapError(toError)),
        ),
      );

    const stagePrefix = ({ stack, stage }: { stack: string; stage: string }) =>
      `${prefix}${stack}/${stage}/`;

    const resourceKey = (request: { stack: string; stage: string; fqn: string }) =>
      `${stagePrefix(request)}${encodeFqn(request.fqn)}.json`;

    const outputKey = (request: { stack: string; stage: string }) =>
      `${stagePrefix(request)}${OUTPUT_FILE}`;

    /** All object keys under `keyPrefix`, across pagination. */
    const listKeys = (bucket: string, keyPrefix: string) =>
      s3.listObjectsV2.pages({ Bucket: bucket, Prefix: keyPrefix }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.Contents ?? [])),
        Stream.map((object) => object.Key),
        Stream.filter((key): key is string => key !== undefined),
        Stream.runCollect,
        Effect.map((keys) => Array.from(keys)),
      );

    /**
     * Immediate "subdirectory" names under `keyPrefix`, derived from
     * S3 CommonPrefixes (delimiter `/`), across pagination.
     */
    const listChildren = (bucket: string, keyPrefix: string) =>
      s3.listObjectsV2.pages({ Bucket: bucket, Prefix: keyPrefix, Delimiter: "/" }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.CommonPrefixes ?? [])),
        // `{keyPrefix}{name}/` -> `{name}`
        Stream.map((common) => common.Prefix),
        Stream.filter((p): p is string => p !== undefined),
        Stream.map((p) => p.slice(keyPrefix.length, -1)),
        Stream.runCollect,
        Effect.map((names) => Array.from(names)),
      );

    /** Read and revive a JSON object; `undefined` when the key is absent. */
    const readJson = <T>(bucket: string, key: string) =>
      s3.getObject({ Bucket: bucket, Key: key }).pipe(
        Effect.flatMap((result) =>
          result.Body === undefined
            ? Effect.succeed(undefined)
            : Stream.mkString(Stream.decodeText(result.Body)).pipe(
                Effect.flatMap((text) =>
                  Effect.try({
                    try: () => JSON.parse(text, reviveState) as T,
                    catch: (cause) =>
                      new StateStoreError({
                        message: `Failed to parse state object '${key}'`,
                        cause: cause instanceof Error ? cause : undefined,
                      }),
                  }),
                ),
              ),
        ),
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
      );

    const writeJson = (bucket: string, key: string, value: unknown) =>
      s3.putObject({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(encodeState(value), null, 2),
        ContentType: "application/json",
      });

    /** Delete every object under `keyPrefix` in batches. Idempotent. */
    const deleteAll = (bucket: string, keyPrefix: string) =>
      Effect.gen(function* () {
        const keys = (yield* listKeys(bucket, keyPrefix)).filter(
          // Leave the lease object. Releasing it here would open the stage
          // before this delete finishes, and the store still holds the lock.
          (key) => !key.endsWith(`/${LEASE_FILE}`),
        );
        for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
          yield* s3.deleteObjects({
            Bucket: bucket,
            Delete: {
              Objects: keys.slice(i, i + DELETE_BATCH_SIZE).map((Key) => ({ Key })),
              Quiet: true,
            },
          });
        }
      });

    const leaseKey = (request: { stack: string; stage: string }) =>
      `${stagePrefix(request)}${LEASE_FILE}`;

    const heldError = (stack: string, stage: string) =>
      new StateStoreError({
        message: `another deploy holds the S3 state lock '${stack}/${stage}'`,
      });

    const lostError = (stack: string, stage: string) =>
      new StateStoreError({
        message: `the S3 state lock '${stack}/${stage}' was lost mid-run; refusing to continue unlocked`,
      });

    /** `undefined` means the conditional write lost (412, or 409 after retries). */
    const putLease = (
      bucket: string,
      key: string,
      record: LeaseRecord,
      condition: { readonly IfNoneMatch: "*" } | { readonly IfMatch: string },
    ) =>
      s3
        .putObject({
          Bucket: bucket,
          Key: key,
          Body: JSON.stringify(record),
          ContentType: "application/json",
          ...condition,
        })
        .pipe(
          Effect.flatMap((result) =>
            result.ETag === undefined
              ? Effect.fail(
                  new StateStoreError({
                    message: `S3 state lock '${key}' was written without an ETag`,
                  }),
                )
              : Effect.succeed(result.ETag),
          ),
          Effect.retry({
            while: (error) => error._tag === "ConditionalRequestConflict",
            schedule: Schedule.spaced("200 millis"),
            times: 4,
          }),
          Effect.catchTag("PreconditionFailed", () => Effect.succeed(undefined)),
          Effect.catchTag("ConditionalRequestConflict", () => Effect.succeed(undefined)),
        );

    const readLease = (bucket: string, key: string) =>
      s3.getObject({ Bucket: bucket, Key: key }).pipe(
        Effect.flatMap((result) => {
          const etag = result.ETag;
          if (result.Body === undefined || etag === undefined) {
            return Effect.succeed(undefined);
          }
          return Stream.mkString(Stream.decodeText(result.Body)).pipe(
            Effect.map((text) => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = undefined;
              }
              const record =
                typeof parsed === "object" &&
                parsed !== null &&
                "token" in parsed &&
                "expiresAt" in parsed &&
                typeof parsed.token === "string" &&
                typeof parsed.expiresAt === "number"
                  ? { token: parsed.token, expiresAt: parsed.expiresAt }
                  : { token: "", expiresAt: 0 };
              return { etag, record };
            }),
          );
        }),
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
      );

    const acquireLease = (stack: string, stage: string) =>
      Effect.gen(function* () {
        const key = leaseKey({ stack, stage });
        const token = yield* Effect.sync(() => crypto.randomUUID());
        const now = yield* Clock.currentTimeMillis;
        const fresh: LeaseRecord = { token, expiresAt: now + LEASE_TTL_MS };
        const created = yield* run((bucket) => putLease(bucket, key, fresh, { IfNoneMatch: "*" }));
        let etag = created;
        if (etag === undefined) {
          const existing = yield* run((bucket) => readLease(bucket, key));
          if (existing === undefined || existing.record.expiresAt > now) {
            return yield* Effect.fail(heldError(stack, stage));
          }
          const replaced = yield* run((bucket) =>
            putLease(bucket, key, fresh, { IfMatch: existing.etag }),
          );
          if (replaced === undefined) {
            return yield* Effect.fail(heldError(stack, stage));
          }
          etag = replaced;
        }

        const cursor = { etag, lost: false };
        const gate = Semaphore.makeUnsafe(1);

        const renew = Semaphore.withPermits(
          gate,
          1,
        )(
          Effect.gen(function* () {
            if (cursor.lost) return;
            const renewedAt = yield* Clock.currentTimeMillis;
            const next = yield* run((bucket) =>
              putLease(
                bucket,
                key,
                { token, expiresAt: renewedAt + LEASE_TTL_MS },
                { IfMatch: cursor.etag },
              ),
            );
            if (next === undefined) cursor.lost = true;
            else cursor.etag = next;
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
            const existing = yield* run((bucket) => readLease(bucket, key));
            const observedAt = yield* Clock.currentTimeMillis;
            if (
              existing === undefined ||
              existing.record.token !== token ||
              existing.record.expiresAt <= observedAt
            ) {
              cursor.lost = true;
              return yield* Effect.fail(lostError(stack, stage));
            }
            cursor.etag = existing.etag;
          }),
        );

        // Interrupt the refresh before releasing, so a refresh cannot
        // land after the lease has been expired.
        yield* Scope.addFinalizer(
          leaseScope,
          Semaphore.withPermits(
            gate,
            1,
          )(
            Effect.gen(function* () {
              cursor.lost = true;
              // Read the etag we actually hold. A refresh that landed after
              // the cursor was last stored would make a release against the
              // old etag a no-op, and the lease would stay live.
              const existing = yield* run((bucket) => readLease(bucket, key));
              if (existing === undefined || existing.record.token !== token) return;
              const releasedAt = yield* Clock.currentTimeMillis;
              yield* run((bucket) =>
                putLease(bucket, key, { token, expiresAt: releasedAt }, { IfMatch: existing.etag }),
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

        return { checkLive: amortizeCheck(verify, LEASE_CHECK_TTL_MS) };
      });

    // One lease per (stack, stage), taken on the first operation and held
    // for the store's lifetime. The mutex keeps two concurrent first
    // operations in this process from contending with each other.
    const leaseMutex = Semaphore.makeUnsafe(1);
    const leases = new Map<string, Effect.Effect<HeldLease, StateStoreError>>();

    const leaseFor = (stack: string, stage: string): Effect.Effect<HeldLease, StateStoreError> =>
      Semaphore.withPermits(
        leaseMutex,
        1,
      )(
        Effect.gen(function* () {
          const key = `${stack}/${stage}`;
          const existing = leases.get(key);
          if (existing !== undefined) return existing;
          const cached = yield* Effect.cached(acquireLease(stack, stage));
          leases.set(key, cached);
          return cached;
        }),
      ).pipe(Effect.flatMap((lease) => lease));

    const guarded = <A>(
      request: { stack: string; stage: string },
      op: Effect.Effect<A, StateStoreError>,
    ): Effect.Effect<A, StateStoreError> =>
      leaseFor(request.stack, request.stage).pipe(
        Effect.flatMap((lease) => lease.checkLive),
        Effect.andThen(op),
      );

    const verifyHeldLeases: Effect.Effect<void, StateStoreError> = Effect.suspend(() =>
      Effect.forEach(
        Array.from(leases.values()),
        (lease) => lease.pipe(Effect.flatMap((held) => held.checkLive)),
        { discard: true },
      ),
    );

    const state: StateService = {
      id: "s3",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        verifyHeldLeases.pipe(Effect.andThen(run((bucket) => listChildren(bucket, prefix)))),
      listStages: (stack: string) =>
        verifyHeldLeases.pipe(
          Effect.andThen(run((bucket) => listChildren(bucket, `${prefix}${stack}/`))),
        ),
      get: (request) =>
        guarded(
          request,
          run((bucket) => readJson<PersistedState>(bucket, resourceKey(request))),
        ),
      getReplacedResources: Effect.fn(function* (request) {
        return (yield* Effect.all(
          (yield* state.list(request)).map((fqn) =>
            state.get({
              stack: request.stack,
              stage: request.stage,
              fqn,
            }),
          ),
        )).filter((r) => r?.status === "replaced");
      }),
      set: (request) =>
        guarded(
          request,
          run((bucket) => writeJson(bucket, resourceKey(request), request.value)).pipe(
            Effect.map(() => request.value),
          ),
        ),
      delete: (request) =>
        guarded(
          request,
          run((bucket) => s3.deleteObject({ Bucket: bucket, Key: resourceKey(request) })).pipe(
            Effect.asVoid,
          ),
        ),
      // A stack-wide delete locks every stage it is about to remove, so a
      // concurrent deploy fails the lease instead of racing the delete.
      deleteStack: ({ stack, stage }) =>
        stage === undefined
          ? verifyHeldLeases.pipe(
              Effect.andThen(state.listStages(stack)),
              Effect.flatMap((stages) =>
                Effect.forEach(
                  stages,
                  (found) =>
                    guarded(
                      { stack, stage: found },
                      run((bucket) => deleteAll(bucket, stagePrefix({ stack, stage: found }))),
                    ),
                  { discard: true },
                ),
              ),
              Effect.andThen(run((bucket) => deleteAll(bucket, `${prefix}${stack}/`))),
            )
          : guarded(
              { stack, stage },
              run((bucket) => deleteAll(bucket, stagePrefix({ stack, stage }))),
            ),
      list: (request) =>
        guarded(
          request,
          run((bucket) => listKeys(bucket, stagePrefix(request))).pipe(
            Effect.map((keys) =>
              keys
                .map((key) => key.slice(stagePrefix(request).length))
                // Filter bookkeeping before decoding — `decodeFqn` replaces
                // `__` with `/`, which would turn `__stack_output__` into
                // `/stack_output/` and slip past the filter.
                .filter(
                  (file) => file !== OUTPUT_FILE && file !== LEASE_FILE && file.endsWith(".json"),
                )
                .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
            ),
          ),
        ),
      getOutput: (request) =>
        guarded(
          request,
          run((bucket) => readJson(bucket, outputKey(request))),
        ),
      setOutput: (request) =>
        guarded(
          request,
          run((bucket) => writeJson(bucket, outputKey(request), request.value)).pipe(
            Effect.map(() => request.value),
          ),
        ),
    };
    return state;
  }).pipe(withoutSdkDebugLogs);

/**
 * Build the default account-regional state bucket name.
 *
 * Account-regional buckets must follow the naming convention:
 *   `<prefix>-<accountId>-<region>-an`
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html#account-regional-gp-buckets
 */
export const createStateBucketName = (accountId: string, region: string) =>
  `alchemy-state-${accountId}-${region}-an`.toLowerCase();

/**
 * Observe-then-ensure the state bucket: head it, create it if missing
 * (tolerating create races), and wait for it to become available.
 */
const ensureStateBucket = (bucket: string, region: string, options: S3StateOptions) =>
  Effect.gen(function* () {
    // An absent bucket surfaces as either `NotFound` (the HEAD 404) or
    // `NoSuchBucket` depending on the namespace/path — treat both as "create
    // it". Catching only `NotFound` let a deleted state bucket (e.g. after a
    // nuke) escape as an uncaught `NoSuchBucket` instead of being recreated.
    const exists = yield* s3.headBucket({ Bucket: bucket }).pipe(
      Effect.map(() => true),
      Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
    );
    if (!exists) {
      yield* Effect.logInfo(`S3 state store: creating bucket ${bucket} in ${region}`);
      yield* s3
        .createBucket({
          Bucket: bucket,
          // account-regional namespace: the bucket name only needs to be
          // unique within this account+region, so deterministic default
          // names can't collide with other AWS customers.
          BucketNamespace: "account-regional",
          // us-east-1 rejects an explicit LocationConstraint
          ...(region === "us-east-1"
            ? {}
            : {
                CreateBucketConfiguration: {
                  LocationConstraint: region as s3.BucketLocationConstraint,
                },
              }),
        })
        .pipe(
          // Many callers race to create the shared default state bucket on
          // first use. The loser sees the create already done
          // (`BucketAlreadyOwnedByYou`/`BucketAlreadyExists`) or mid-flight
          // (`OperationAborted`). All mean "someone else is creating it".
          Effect.catchTag(
            ["BucketAlreadyOwnedByYou", "BucketAlreadyExists", "OperationAborted"],
            () => Effect.void,
          ),
        );

      // Wait for the bucket to become available. Under a concurrent create
      // the bucket is briefly not yet head-able and object/configuration ops
      // would race ahead of it.
      yield* s3.headBucket({ Bucket: bucket }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotFound" || error._tag === "NoSuchBucket",
          schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(10)]),
        }),
      );
    }

    // Secure defaults are reconciled for BOTH newly-created and existing
    // buckets. This makes AWS.state converge out-of-band drift and explicit
    // custom buckets rather than only securing the greenfield path.
    const desiredVersioning = "Enabled";
    const observedVersioning = yield* s3.getBucketVersioning({
      Bucket: bucket,
    });
    if (observedVersioning.Status !== desiredVersioning) {
      yield* s3.putBucketVersioning({
        Bucket: bucket,
        VersioningConfiguration: { Status: desiredVersioning },
      });
    }

    yield* syncBucketEncryption(bucket, options.encryption);

    const desiredPublicAccess: s3.PublicAccessBlockConfiguration = {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    };
    const observedPublicAccess = yield* s3.getPublicAccessBlock({ Bucket: bucket }).pipe(
      Effect.map((result) => result.PublicAccessBlockConfiguration),
      Effect.catchTag("NoSuchPublicAccessBlockConfiguration", () =>
        Effect.succeed<s3.PublicAccessBlockConfiguration | undefined>(undefined),
      ),
    );
    const publicAccessFingerprint = (config: s3.PublicAccessBlockConfiguration | undefined) =>
      JSON.stringify({
        blockAcls: config?.BlockPublicAcls ?? false,
        ignoreAcls: config?.IgnorePublicAcls ?? false,
        blockPolicy: config?.BlockPublicPolicy ?? false,
        restrictBuckets: config?.RestrictPublicBuckets ?? false,
      });
    if (
      publicAccessFingerprint(observedPublicAccess) !== publicAccessFingerprint(desiredPublicAccess)
    ) {
      yield* s3.putPublicAccessBlock({
        Bucket: bucket,
        PublicAccessBlockConfiguration: desiredPublicAccess,
      });
    }

    const desiredOwnership = "BucketOwnerEnforced";
    const observedOwnership = yield* s3.getBucketOwnershipControls({ Bucket: bucket }).pipe(
      Effect.map((result) => result.OwnershipControls?.Rules?.[0]?.ObjectOwnership),
      Effect.catchTag("OwnershipControlsNotFoundError", () =>
        Effect.succeed<string | undefined>(undefined),
      ),
    );
    if (observedOwnership !== desiredOwnership) {
      yield* s3.putBucketOwnershipControls({
        Bucket: bucket,
        OwnershipControls: {
          Rules: [{ ObjectOwnership: desiredOwnership }],
        },
      });
    }
  }).pipe(
    // The whole observe→create→wait sequence races other first-callers of the
    // shared bucket; `OperationAborted` (conflicting create) and a transiently
    // absent bucket (`NoSuchBucket`/`NotFound`) are the faces of that race.
    // Retry the entire sequence so a concurrent create that is still settling
    // converges instead of surfacing as a `StateStoreError`.
    Effect.retry({
      while: (e) =>
        e._tag === "OperationAborted" || e._tag === "NoSuchBucket" || e._tag === "NotFound",
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(10)]),
    }),
  );
