import type { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
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
import { GcpAuth } from "../AuthProvider.ts";
import * as GcpCredentials from "../Credentials.ts";
import { fromCredentials, GcpEnvironment } from "../Environment.ts";
import { makeObjectMedia } from "../Storage/ObjectMedia.ts";

/**
 * The bookkeeping object that stores a stack's resolved output. Lives
 * alongside the resource objects under the same stage prefix, so it
 * must be filtered out of `list` results before FQN decoding.
 */
const OUTPUT_FILE = "__stack_output__.json";

/**
 * Holds one lock object per `(stack, stage)`, at
 * `{prefix}__locks__/{stack}/{stage}`. Locks live outside the stage
 * trees so a held lock never keeps a deleted stage in `listStages`.
 * `listStacks` skips this name.
 */
const LOCKS_DIR = "__locks__";

/** A lock that has not been refreshed for this long has expired. */
const LOCK_TTL_MS = 60_000;

/** How often the holder pushes its lock's expiry forward, start to start. */
const LOCK_REFRESH = "20 seconds";

/** A refresh still running after this long is abandoned until the next round. */
const LOCK_REFRESH_TIMEOUT = "10 seconds";

/**
 * The holder stops using its lock this long before the lock expires. It
 * covers clock skew between machines (a contender judges expiry by its
 * own clock) and writes still in flight.
 */
const LOCK_MARGIN_MS = 15_000;

/** Parallel object deletes when removing a stage. */
const DELETE_CONCURRENCY = 16;

export interface GcsStateOptions {
  /**
   * Name of the Cloud Storage bucket that holds the state objects. The
   * bucket is created on first use if it does not exist.
   *
   * There is no default: bucket names are global across Cloud Storage,
   * so a name derived from the project could already belong to someone
   * else.
   */
  bucketName: string;
  /**
   * Object name prefix within the bucket under which all state objects
   * are stored, e.g. `"alchemy"`. A trailing `/` is appended
   * automatically. Set one when the bucket also holds other data.
   *
   * @default "" (bucket root)
   */
  prefix?: string;
}

/** Context required by the distilled Cloud Storage operations. */
type GcsDeps = Credentials | HttpClient | GcpEnvironment;

/** A held `(stack, stage)` lock. */
interface Lease {
  /** Fails once the lock is lost or about to expire. Never calls Cloud Storage. */
  readonly checkLive: Effect.Effect<void, StateStoreError>;
}

/**
 * Settings for a bucket the store creates: object versioning keeps
 * overwritten and deleted state recoverable, uniform bucket-level access
 * leaves IAM as the only way to grant access, and public access
 * prevention blocks public access even if an IAM policy allows it.
 */
const SECURE_DEFAULTS = {
  versioning: { enabled: true },
  iamConfiguration: {
    uniformBucketLevelAccess: { enabled: true },
    publicAccessPrevention: "enforced",
  },
} satisfies storage.Bucket;

/**
 * State store backed by a Google Cloud Storage bucket.
 *
 * Stack state is persisted as JSON objects, laid out exactly like the
 * local state store's file tree with the bucket (plus optional `prefix`)
 * taking the place of the `.alchemy/state` directory. Locks sit in a
 * separate directory:
 *
 * ```
 * gs://{bucket}/{prefix}{stack}/{stage}/{fqn}.json
 * gs://{bucket}/{prefix}{stack}/{stage}/__stack_output__.json
 * gs://{bucket}/{prefix}__locks__/{stack}/{stage}
 * ```
 *
 * Concurrent deploys are serialized with one lock object per
 * `(stack, stage)`, taken by the first state operation for the pair —
 * reads included, so reading another stack's outputs takes that stack's
 * lock too, as with `postgresState()`. The lock is created with
 * `ifGenerationMatch=0`, so only one store can hold it, and contention
 * fails immediately instead of queueing. The holder refreshes the lock's
 * expiry every 20 seconds and deletes it when the store closes; both
 * writes match the generation it created, so they never touch a lock
 * another store has since taken. If the holder cannot refresh, it stops
 * running state operations 15 seconds before its lock expires.
 *
 * A deploy that crashes stops refreshing: its lock expires within a
 * minute, and the next deploy deletes the expired lock and takes the
 * stage. Expiry compares clocks across machines, so the 15 seconds also
 * bound how far they may drift apart.
 *
 * The bucket is created on the first state operation if it does not
 * exist, with object versioning, uniform bucket-level access and public
 * access prevention. An existing bucket is used as it is. The store
 * needs `storage.buckets.get` and the `storage.objects` permissions
 * `create`, `delete`, `get`, `list` and `update` on the bucket, plus
 * `storage.buckets.create` on the project if the bucket is missing.
 *
 * ### Using the GCS State Store
 * Pass `GCP.state()` as the `state` option of a Stack.
 *
 * **Example:** State in a dedicated bucket
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as GCP from "alchemy/GCP";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: GCP.providers(),
 *     state: GCP.state({ bucketName: "my-company-alchemy-state" }),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * **Example:** State under a prefix of a shared bucket
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: GCP.providers(),
 *     state: GCP.state({
 *       bucketName: "my-company-infra-state",
 *       prefix: "alchemy",
 *     }),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * @resource
 */
export const state = (options: GcsStateOptions) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<GcsDeps>();

      // Locks belong to this layer's scope. The cached effect runs on the
      // first state operation, which may sit in a shorter scope.
      const make = makeGcsState(options).pipe(
        Scope.provide(scope),
        recordStateStoreInit,
        Effect.orDie,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  ).pipe(
    Layer.provideMerge(fromCredentials()),
    Layer.provideMerge(GcpCredentials.fromAuthProvider()),
    Layer.provideMerge(GcpAuth),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );

/**
 * Construct a GCS-backed {@link StateService}.
 *
 * Construction itself never touches Cloud Storage — the ensure-bucket
 * check is deferred into a cached Effect that runs once, on the first
 * state operation. Locks taken by the store are released when the
 * ambient `Scope` closes.
 */
export const makeGcsState = (options: GcsStateOptions) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<GcsDeps>();
    // Media endpoints for object content: the generated SDK only covers
    // object metadata.
    const media = yield* makeObjectMedia;
    // One token per store, so a lock this store created without seeing
    // the response is still recognized as its own.
    const token = yield* Effect.sync(() => crypto.randomUUID());

    const bucketName = options.bucketName;
    const prefix = options.prefix ? `${options.prefix.replace(/\/+$/, "")}/` : "";

    const toError = (cause: unknown): StateStoreError =>
      cause instanceof StateStoreError
        ? cause
        : new StateStoreError({
            message:
              cause instanceof Error && cause.message
                ? cause.message
                : `GCS state store error: ${String(cause)}`,
            cause: cause instanceof Error ? cause : undefined,
          });

    // Nothing touches Cloud Storage at construction time. `Effect.cached`
    // runs the bucket check once, on the first state operation, and locks
    // concurrent first callers onto that single run.
    const ready = yield* Effect.cached(
      ensureStateBucket(bucketName).pipe(Effect.provideContext(context), Effect.mapError(toError)),
    );

    // Close over the captured context so every StateService method is
    // self-contained (`R = never`), matching the StateService contract.
    const run = <A, E>(effect: Effect.Effect<A, E, GcsDeps>): Effect.Effect<A, StateStoreError> =>
      ready.pipe(
        Effect.andThen(effect.pipe(Effect.provideContext(context), Effect.mapError(toError))),
      );

    const stagePrefix = ({ stack, stage }: { stack: string; stage: string }) =>
      `${prefix}${stack}/${stage}/`;

    const resourceKey = (request: { stack: string; stage: string; fqn: string }) =>
      `${stagePrefix(request)}${encodeFqn(request.fqn)}.json`;

    const outputKey = (request: { stack: string; stage: string }) =>
      `${stagePrefix(request)}${OUTPUT_FILE}`;

    const lockKey = ({ stack, stage }: { stack: string; stage: string }) =>
      `${prefix}${LOCKS_DIR}/${stack}/${stage}`;

    /** All object names under `keyPrefix`, across pagination. */
    const listKeys = (keyPrefix: string) =>
      storage.listObjects.items({ bucket: bucketName, prefix: keyPrefix }).pipe(
        Stream.map((object) => object.name),
        Stream.filter((name): name is string => name !== undefined),
        Stream.runCollect,
        Effect.map((names) => Array.from(names)),
      );

    /**
     * Immediate "subdirectory" names under `keyPrefix`, derived from the
     * listing's prefixes (delimiter `/`), across pagination.
     */
    const listChildren = (keyPrefix: string) =>
      storage.listObjects.pages({ bucket: bucketName, prefix: keyPrefix, delimiter: "/" }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.prefixes ?? [])),
        // `{keyPrefix}{name}/` -> `{name}`
        Stream.map((p) => p.slice(keyPrefix.length, -1)),
        Stream.runCollect,
        Effect.map((names) => Array.from(names)),
      );

    /** Read and revive a JSON object; `undefined` when the object is absent. */
    const readJson = <T>(key: string) =>
      media.download({ bucket: bucketName, object: key }).pipe(
        Effect.flatMap(({ body }) =>
          Effect.try({
            try: () => JSON.parse(new TextDecoder().decode(body), reviveState) as T,
            catch: (cause) =>
              new StateStoreError({
                message: `Failed to parse state object '${key}'`,
                cause: cause instanceof Error ? cause : undefined,
              }),
          }),
        ),
        Effect.catchTag("GCP.Storage.ObjectNotFound", () => Effect.succeed(undefined)),
      );

    const writeJson = (key: string, value: unknown) =>
      media.upload(bucketName, {
        name: key,
        body: JSON.stringify(encodeState(value), null, 2),
        contentType: "application/json",
      });

    /** Delete one object. Idempotent. */
    const deleteObject = (key: string) =>
      storage.deleteObjects({ bucket: bucketName, object: key }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
      );

    /** Delete every object under `keyPrefix`. Idempotent. */
    const deleteAll = (keyPrefix: string) =>
      listKeys(keyPrefix).pipe(
        Effect.flatMap((keys) =>
          Effect.forEach(keys, deleteObject, { concurrency: DELETE_CONCURRENCY, discard: true }),
        ),
      );

    const lockUrl = (request: { stack: string; stage: string }) =>
      `gs://${bucketName}/${lockKey(request)}`;

    const heldError = (request: { stack: string; stage: string }, expiresAt?: number) =>
      new StateStoreError({
        message:
          `another deploy holds the GCS state lock '${lockUrl(request)}'` +
          (expiresAt === undefined
            ? ""
            : ` (it expires at ${new Date(expiresAt).toISOString()} unless its holder refreshes it)`),
      });

    const lostError = (request: { stack: string; stage: string }) =>
      new StateStoreError({
        message: `the GCS state lock '${lockUrl(request)}' was lost mid-run; refusing to continue unlocked`,
      });

    /** Custom metadata of a lock object that expires `LOCK_TTL_MS` after `now`. */
    const lockMetadata = (now: number) => ({
      token,
      expiresAt: new Date(now + LOCK_TTL_MS).toISOString(),
    });

    /** A lock object without a readable expiry counts as expired. */
    const expiresAtOf = (lock: storage.Storage_Object) => {
      const expiresAt = Date.parse(lock.metadata?.expiresAt ?? "");
      return Number.isNaN(expiresAt) ? 0 : expiresAt;
    };

    const readLock = (key: string) =>
      storage
        .getObjects({ bucket: bucketName, object: key })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

    /**
     * Create the lock object, or take over an expired one. Returns the
     * generation this store now holds and when it expires. Fails while
     * another store holds a live lock.
     */
    const takeLock = (request: { stack: string; stage: string }) =>
      Effect.gen(function* () {
        const key = lockKey(request);
        // A lock released or deleted between two steps sends us around
        // again. Still contended after three rounds counts as held.
        for (let round = 0; round < 3; round++) {
          const now = yield* Clock.currentTimeMillis;
          const created = yield* media
            .create(bucketName, { name: key, body: "", metadata: lockMetadata(now) })
            .pipe(
              Effect.catchTag("GCP.Storage.ObjectAlreadyExists", () => Effect.succeed(undefined)),
            );
          const existing = created ?? (yield* readLock(key));
          if (existing?.generation === undefined) continue;
          const expiresAt = expiresAtOf(existing);
          // Ours: just created, or created by this store earlier without
          // it seeing the response.
          if (existing.metadata?.token === token) {
            return { generation: existing.generation, expiresAt };
          }
          if (expiresAt > now) return yield* heldError(request, expiresAt);
          // Delete exactly the expired version. A holder that refreshed in
          // the meantime bumped the metageneration, so the delete fails
          // instead of removing a live lock.
          yield* storage
            .deleteObjects({
              bucket: bucketName,
              object: key,
              ifGenerationMatch: existing.generation,
              ifMetagenerationMatch: existing.metageneration,
            })
            .pipe(
              Effect.andThen(
                Effect.logWarning(
                  `GCS state store: removed the expired state lock '${lockUrl(request)}'; the deploy that held it did not finish`,
                ),
              ),
              Effect.catchTag(["NotFound", "ObjectPreconditionFailed"], () => Effect.void),
            );
        }
        return yield* heldError(request);
      });

    const releaseLock = (request: { stack: string; stage: string }, generation: string) =>
      storage
        .deleteObjects({
          bucket: bucketName,
          object: lockKey(request),
          ifGenerationMatch: generation,
        })
        .pipe(
          // Already gone, or taken over after it expired: nothing of ours
          // is left to release.
          Effect.catchTag(["NotFound", "ObjectPreconditionFailed"], () => Effect.void),
          // Never fail the store's shutdown. A lock left behind expires.
          Effect.catch((error) =>
            Effect.logWarning(
              `GCS state store: failed to release the state lock '${lockUrl(request)}': ${error.message}`,
            ),
          ),
          Effect.provideContext(context),
        );

    /**
     * Take the `(stack, stage)` lock for the store's lifetime: create it,
     * refresh its expiry in the background, and delete it when the store's
     * scope closes.
     *
     * Liveness is tracked locally. Once the lock exists, no other store can
     * take it until it expires, and the expiry is what this store last
     * wrote. So the lock is live while a refresh has succeeded recently
     * enough, and lost as soon as a refresh finds another generation.
     */
    const acquireLock = (request: { stack: string; stage: string }) =>
      Effect.gen(function* () {
        const held = yield* Effect.acquireRelease(
          run(takeLock(request)),
          ({ generation }) => releaseLock(request, generation),
          // Interrupting a slow acquire may leave a lock behind; it expires.
          { interruptible: true },
        ).pipe(Scope.provide(scope));

        let validUntil = held.expiresAt;
        let lost = false;

        const refresh = Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          yield* storage
            .patchObjects({
              bucket: bucketName,
              object: lockKey(request),
              ifGenerationMatch: held.generation,
              body: { metadata: lockMetadata(startedAt) },
            })
            .pipe(Effect.timeout(LOCK_REFRESH_TIMEOUT));
          validUntil = startedAt + LOCK_TTL_MS;
        }).pipe(
          Effect.catchTag(["NotFound", "ObjectPreconditionFailed"], () =>
            Effect.sync(() => {
              lost = true;
            }),
          ),
          // Other failures are retried on the next round. If none succeeds
          // in time, `checkLive` reports the lock lost.
          Effect.catch((error) =>
            Effect.logWarning(
              `GCS state store: failed to refresh the state lock '${lockUrl(request)}': ${error.message}`,
            ),
          ),
          Effect.provideContext(context),
        );
        yield* refresh.pipe(
          Effect.repeat({ schedule: Schedule.fixed(LOCK_REFRESH), while: () => !lost }),
          Effect.forkIn(scope),
        );

        const checkLive = Effect.gen(function* () {
          if (!lost) {
            const now = yield* Clock.currentTimeMillis;
            if (now < validUntil - LOCK_MARGIN_MS) return;
            lost = true;
          }
          return yield* lostError(request);
        });

        return { checkLive } satisfies Lease;
      });

    // One lock per (stack, stage), taken by the first operation that
    // touches the pair and held for the store's lifetime. The mutex makes
    // acquisition single-flight, so two concurrent first operations cannot
    // contend with each other. A failed acquisition is not remembered: the
    // next operation tries again.
    const leaseMutex = Semaphore.makeUnsafe(1);
    const leases = new Map<string, Lease>();

    const leaseFor = (request: { stack: string; stage: string }) =>
      Semaphore.withPermits(
        leaseMutex,
        1,
      )(
        Effect.suspend(() => {
          const key = lockKey(request);
          const held = leases.get(key);
          if (held !== undefined) return Effect.succeed(held);
          return acquireLock(request).pipe(
            Effect.tap((lease) =>
              Effect.sync(() => {
                leases.set(key, lease);
              }),
            ),
          );
        }),
      );

    /**
     * Every storage operation on a `(stack, stage)` first ensures this
     * store holds the pair's lock and that the lock is still live. Reads
     * are guarded too, not just writes: a lost lock means a concurrent
     * deploy may already be writing these objects.
     */
    const guarded = <A>(
      request: { stack: string; stage: string },
      op: Effect.Effect<A, StateStoreError>,
    ): Effect.Effect<A, StateStoreError> =>
      leaseFor(request).pipe(
        Effect.flatMap((lease) => lease.checkLive),
        Effect.andThen(op),
      );

    // Operations without a stage cannot name a single lock, so they
    // re-verify every lock this store currently holds instead.
    const verifyHeldLeases: Effect.Effect<void, StateStoreError> = Effect.suspend(() =>
      Effect.forEach(Array.from(leases.values()), (lease) => lease.checkLive, { discard: true }),
    );

    const service: StateService = {
      id: "gcs",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        verifyHeldLeases.pipe(
          Effect.andThen(run(listChildren(prefix))),
          Effect.map((names) => names.filter((name) => name !== LOCKS_DIR)),
        ),
      listStages: (stack) =>
        verifyHeldLeases.pipe(Effect.andThen(run(listChildren(`${prefix}${stack}/`)))),
      get: (request) => guarded(request, run(readJson<PersistedState>(resourceKey(request)))),
      getReplacedResources: Effect.fn(function* (request) {
        return (yield* Effect.all(
          (yield* service.list(request)).map((fqn) =>
            service.get({
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
          run(writeJson(resourceKey(request), request.value)).pipe(Effect.as(request.value)),
        ),
      delete: (request) => guarded(request, run(deleteObject(resourceKey(request)))),
      // Deleting a whole stack takes the lock of every stage it removes, so
      // a concurrent deploy of any of them fails the lock instead of racing
      // the delete. A stage created after the listing is left alone: its
      // own deploy holds it.
      deleteStack: ({ stack, stage }) =>
        stage === undefined
          ? verifyHeldLeases.pipe(
              Effect.andThen(service.listStages(stack)),
              Effect.flatMap((stages) =>
                Effect.forEach(
                  stages,
                  (found) =>
                    guarded(
                      { stack, stage: found },
                      run(deleteAll(stagePrefix({ stack, stage: found }))),
                    ),
                  { discard: true },
                ),
              ),
            )
          : guarded({ stack, stage }, run(deleteAll(stagePrefix({ stack, stage })))),
      list: (request) =>
        guarded(
          request,
          run(listKeys(stagePrefix(request))).pipe(
            Effect.map((keys) =>
              keys
                .map((key) => key.slice(stagePrefix(request).length))
                // Filter the bookkeeping file before decoding — `decodeFqn`
                // replaces `__` with `/`, which would turn the literal name
                // `__stack_output__` into `/stack_output/` and slip past
                // the filter, leaving the engine to look up a non-existent
                // resource.
                .filter((file) => file !== OUTPUT_FILE && file.endsWith(".json"))
                .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
            ),
          ),
        ),
      getOutput: (request) => guarded(request, run(readJson(outputKey(request)))),
      setOutput: (request) =>
        guarded(
          request,
          run(writeJson(outputKey(request), request.value)).pipe(Effect.as(request.value)),
        ),
    };
    return service;
  });

/**
 * Observe-then-ensure the state bucket. A missing bucket is created with
 * {@link SECURE_DEFAULTS}. An existing bucket is used as it is: it may
 * hold other data or be managed elsewhere, and uniform bucket-level
 * access cannot be turned off again after 90 days.
 */
const ensureStateBucket = (bucketName: string) =>
  storage.getBuckets({ bucket: bucketName }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => createStateBucket(bucketName)),
  );

const createStateBucket = (bucketName: string) =>
  Effect.gen(function* () {
    const { project, region } = yield* GcpEnvironment.current;
    yield* Effect.logInfo(`GCS state store: creating bucket ${bucketName} in ${region}`);
    yield* storage
      .insertBuckets({
        project,
        body: { name: bucketName, location: region, ...SECURE_DEFAULTS },
      })
      .pipe(
        // Bucket names are global. `Conflict` means it exists: created by a
        // concurrent first caller, or owned by someone else, in which case
        // the read fails with `Forbidden`.
        Effect.catchTag("Conflict", () => storage.getBuckets({ bucket: bucketName })),
      );
  });
