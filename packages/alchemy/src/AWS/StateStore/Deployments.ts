import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import {
  DEPLOYMENT_TTL_MILLIS,
  DeploymentInProgress,
  DeploymentNotFound,
  DeploymentTokenInvalid,
  type DeploymentEvent,
  type DeploymentRecord,
  type DeploymentStore,
} from "../../State/Deployment.ts";
import { StateStoreError } from "../../State/State.ts";

/**
 * S3-backed {@link DeploymentStore}.
 *
 * Layout under the state store's stage prefix (`{prefix}{stack}/{stage}/`):
 *
 * ```
 * .deployments/{version:08d}/record.json                 # lifecycle record (+ open token)
 * .deployments/{version:08d}/events/{firstSeq:08d}.json  # one object per appended batch
 * ```
 *
 * S3 has no append, so the journal is one object per batch; 8-digit
 * zero-padded keys make lexicographic key order equal replay order.
 *
 * Version allocation uses S3 conditional writes as the claim primitive:
 * `PutObject` of `record.json` with `If-None-Match: "*"` — exactly one of
 * two racing begins can create the object, the loser observes the typed
 * `PreconditionFailed` (or transient `ConditionalRequestConflict`),
 * re-scans the open records, and either surfaces the live holder as
 * {@link DeploymentInProgress} or retries at the next version.
 *
 * `heartbeat`/`end` are read-modify-write of `record.json` guarded with
 * `If-Match` on the record's ETag so a concurrent `begin` reconciling the
 * same record to `"abandoned"` is never silently clobbered — the loser of
 * the OCC race re-reads and re-applies.
 */

/** Reserved directory name for deployment history under a stage prefix. */
export const DEPLOYMENTS_DIR = ".deployments";

/** Internal record shape: the public record plus the open token. */
export interface StoredDeploymentRecord extends DeploymentRecord {
  token: string;
}

/** Zero-pad to 8 digits so lexicographic key order equals numeric order. */
export const pad8 = (n: number): string => n.toString().padStart(8, "0");

/** `{stagePrefix}.deployments/` */
export const deploymentsPrefix = (stagePrefix: string): string =>
  `${stagePrefix}${DEPLOYMENTS_DIR}/`;

/** `{stagePrefix}.deployments/{version:08d}/` */
export const versionPrefix = (stagePrefix: string, version: number): string =>
  `${deploymentsPrefix(stagePrefix)}${pad8(version)}/`;

/** `{stagePrefix}.deployments/{version:08d}/record.json` */
export const recordKey = (stagePrefix: string, version: number): string =>
  `${versionPrefix(stagePrefix, version)}record.json`;

/** `{stagePrefix}.deployments/{version:08d}/events/` */
export const eventsPrefix = (stagePrefix: string, version: number): string =>
  `${versionPrefix(stagePrefix, version)}events/`;

/** `{stagePrefix}.deployments/{version:08d}/events/{firstSeq:08d}.json` */
export const batchKey = (
  stagePrefix: string,
  version: number,
  firstSeq: number,
): string => `${eventsPrefix(stagePrefix, version)}${pad8(firstSeq)}.json`;

const RECORD_KEY_RE = /^(\d{8})\/record\.json$/;

/**
 * Extract the version from a `record.json` object key, or `undefined` for
 * anything else under the deployments prefix (event batches, foreign keys).
 */
export const versionFromRecordKey = (
  deploymentsKeyPrefix: string,
  key: string,
): number | undefined => {
  if (!key.startsWith(deploymentsKeyPrefix)) {
    return undefined;
  }
  const match = RECORD_KEY_RE.exec(key.slice(deploymentsKeyPrefix.length));
  return match === null ? undefined : Number.parseInt(match[1]!, 10);
};

/**
 * An open record whose heartbeat is at least `ttlMillis` old is stale and
 * gets reconciled to `"abandoned"` by the next `begin`.
 */
export const isStaleOpen = (
  record: Pick<DeploymentRecord, "endedAt" | "heartbeatAt">,
  now: number,
  ttlMillis: number,
): boolean =>
  record.endedAt === undefined && now - record.heartbeatAt >= ttlMillis;

/** Strip the token and deep-copy so callers never alias internal state. */
export const toPublicRecord = (
  record: StoredDeploymentRecord,
): DeploymentRecord => {
  const { token: _token, ...rest } = record;
  return structuredClone(rest);
};

export const encodeRecord = (record: StoredDeploymentRecord): string =>
  JSON.stringify(record, null, 2);

export const decodeRecord = (text: string): StoredDeploymentRecord =>
  JSON.parse(text) as StoredDeploymentRecord;

/** Highest seq in a batch (0 for an empty batch). */
export const maxSeqOf = (events: readonly DeploymentEvent[]): number =>
  events.reduce((max, event) => (event.seq > max ? event.seq : max), 0);

/**
 * Dedupe an incoming batch against the journal's high-water mark.
 *
 * DEDUPE CHOICE: we read the highest stored seq from the lexicographically
 * LAST batch object and drop incoming events whose seq is `<=` it (plus any
 * same-seq repeats inside the batch itself — first occurrence wins). This is
 * sound because every batch is filtered to seqs strictly above the previous
 * high-water mark before it is written, so batch key order equals seq order
 * and the global max seq always lives in the last batch object. The engine
 * assigns contiguous seqs and retries whole batches, so a retried batch is
 * always a suffix-overlap of what is already stored.
 */
export const dedupeBatch = (
  events: readonly DeploymentEvent[],
  maxStoredSeq: number,
): { retained: DeploymentEvent[]; ackedSeq: number } => {
  const bySeq = new Map<number, DeploymentEvent>();
  for (const event of events) {
    if (event.seq > maxStoredSeq && !bySeq.has(event.seq)) {
      bySeq.set(event.seq, event);
    }
  }
  const retained = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  return {
    retained,
    ackedSeq: Math.max(maxStoredSeq, maxSeqOf(retained)),
  };
};

/** Context required by the distilled S3 operations. */
type S3Deps = Credentials | HttpClient | Region;

/** How many times `begin` retries the version claim after losing a race. */
const CLAIM_ATTEMPTS = 8;

/** How many times an If-Match read-modify-write retries after an OCC loss. */
const UPDATE_ATTEMPTS = 4;

/** Bounded fan-out for reading many record/batch objects. */
const READ_CONCURRENCY = 8;

export interface MakeS3DeploymentStoreOptions {
  /**
   * The cached ensure-bucket effect from the surrounding S3 state store —
   * resolves the bucket name lazily on first use.
   */
  bucket: Effect.Effect<string, StateStoreError>;
  /** Captured context that satisfies the distilled S3 operations. */
  context: Context.Context<S3Deps>;
  /** Builds `{prefix}{stack}/{stage}/` exactly like the state store does. */
  stagePrefix: (ids: { stack: string; stage: string }) => string;
}

export const makeS3DeploymentStore = (
  options: MakeS3DeploymentStoreOptions,
): DeploymentStore => {
  const { bucket, context, stagePrefix } = options;

  const toError = (cause: unknown): StateStoreError =>
    cause instanceof StateStoreError
      ? cause
      : new StateStoreError({
          message:
            cause instanceof Error
              ? cause.message
              : `S3 deployment store error: ${String(cause)}`,
          cause: cause instanceof Error ? cause : undefined,
        });

  /** Run a distilled S3 effect with the captured context, keeping its typed errors. */
  const withS3 = <A, E>(
    f: (bucket: string) => Effect.Effect<A, E, S3Deps>,
  ): Effect.Effect<A, E | StateStoreError> =>
    bucket.pipe(
      Effect.flatMap((bucket) =>
        f(bucket).pipe(Effect.provideContext(context)),
      ),
    );

  /** All object keys under `keyPrefix`, across pagination, ascending. */
  const listKeys = (
    keyPrefix: string,
  ): Effect.Effect<string[], StateStoreError> =>
    withS3((bucket) =>
      s3.listObjectsV2.pages({ Bucket: bucket, Prefix: keyPrefix }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.Contents ?? [])),
        Stream.map((object) => object.Key),
        Stream.filter((key): key is string => key !== undefined),
        Stream.runCollect,
        Effect.map((keys) => Array.from(keys).sort()),
      ),
    ).pipe(Effect.mapError(toError));

  const readText = (
    key: string,
  ): Effect.Effect<string | undefined, StateStoreError> =>
    withS3((bucket) =>
      s3.getObject({ Bucket: bucket, Key: key }).pipe(
        Effect.flatMap((result) =>
          result.Body === undefined
            ? Effect.succeed(undefined)
            : Stream.mkString(Stream.decodeText(result.Body)),
        ),
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
      ),
    ).pipe(Effect.mapError(toError));

  interface ReadRecordResult {
    record: StoredDeploymentRecord;
    /** ETag of the object read — the If-Match guard for read-modify-write. */
    etag: string | undefined;
  }

  const readRecord = (request: {
    stack: string;
    stage: string;
    version: number;
  }): Effect.Effect<ReadRecordResult | undefined, StateStoreError> =>
    withS3((bucket) =>
      s3
        .getObject({
          Bucket: bucket,
          Key: recordKey(stagePrefix(request), request.version),
        })
        .pipe(
          Effect.flatMap((result) =>
            result.Body === undefined
              ? Effect.succeed(undefined)
              : Stream.mkString(Stream.decodeText(result.Body)).pipe(
                  Effect.flatMap((text) =>
                    Effect.try({
                      try: (): ReadRecordResult => ({
                        record: decodeRecord(text),
                        etag: result.ETag,
                      }),
                      catch: toError,
                    }),
                  ),
                ),
          ),
          Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
        ),
    ).pipe(Effect.mapError(toError));

  /**
   * Write `record.json`. `condition` selects the S3 conditional-write guard:
   * `create` = If-None-Match: "*" (the version claim), `etag` = If-Match
   * (read-modify-write). Returns "conflict" when the guard rejects the write
   * so callers can re-observe instead of failing.
   */
  const writeRecord = (
    request: { stack: string; stage: string; version: number },
    record: StoredDeploymentRecord,
    condition: { create: true } | { etag: string | undefined },
  ): Effect.Effect<"written" | "conflict", StateStoreError> =>
    withS3((bucket) =>
      s3
        .putObject({
          Bucket: bucket,
          Key: recordKey(stagePrefix(request), request.version),
          Body: encodeRecord(record),
          ContentType: "application/json",
          ...("create" in condition
            ? { IfNoneMatch: "*" }
            : condition.etag !== undefined
              ? { IfMatch: condition.etag }
              : {}),
        })
        .pipe(
          Effect.map(() => "written" as const),
          Effect.catchTag(
            ["PreconditionFailed", "ConditionalRequestConflict"],
            () => Effect.succeed("conflict" as const),
          ),
        ),
    ).pipe(Effect.mapError(toError));

  /** Read the record for a version and enforce the caller's token. */
  const requireRecord = (request: {
    stack: string;
    stage: string;
    version: number;
    token: string;
  }): Effect.Effect<
    ReadRecordResult,
    DeploymentNotFound | DeploymentTokenInvalid | StateStoreError
  > =>
    readRecord(request).pipe(
      Effect.flatMap(
        (
          found,
        ): Effect.Effect<
          ReadRecordResult,
          DeploymentNotFound | DeploymentTokenInvalid
        > => {
          if (found === undefined) {
            return Effect.fail(
              new DeploymentNotFound({
                stack: request.stack,
                stage: request.stage,
                version: request.version,
              }),
            );
          }
          if (found.record.token !== request.token) {
            return Effect.fail(
              new DeploymentTokenInvalid({
                stack: request.stack,
                stage: request.stage,
                version: request.version,
              }),
            );
          }
          return Effect.succeed(found);
        },
      ),
    );

  /**
   * OCC read-modify-write of `record.json`: re-reads and re-applies `update`
   * when the If-Match guard rejects (e.g. a concurrent `begin` reconciled
   * this record to "abandoned" between our read and write). `update`
   * returning `undefined` means "nothing to write" (idempotent no-op).
   */
  const updateRecord = (
    request: { stack: string; stage: string; version: number; token: string },
    update: (
      record: StoredDeploymentRecord,
    ) => StoredDeploymentRecord | undefined,
  ): Effect.Effect<
    void,
    DeploymentNotFound | DeploymentTokenInvalid | StateStoreError
  > =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
        const { record, etag } = yield* requireRecord(request);
        const next = update(record);
        if (next === undefined) {
          return;
        }
        const result = yield* writeRecord(request, next, { etag });
        if (result === "written") {
          return;
        }
        // Lost the OCC race — loop back, re-read, re-apply.
      }
      return yield* Effect.fail(
        toError(
          new Error(
            `deployment record update for ${request.stack}/${request.stage} v${request.version} kept conflicting`,
          ),
        ),
      );
    });

  /** Versions with a record object, ascending. */
  const listVersions = (ids: {
    stack: string;
    stage: string;
  }): Effect.Effect<number[], StateStoreError> => {
    const keyPrefix = deploymentsPrefix(stagePrefix(ids));
    return listKeys(keyPrefix).pipe(
      Effect.map((keys) =>
        keys
          .map((key) => versionFromRecordKey(keyPrefix, key))
          .filter((version): version is number => version !== undefined)
          .sort((a, b) => a - b),
      ),
    );
  };

  /** Read many records, preserving version order, skipping missing ones. */
  const readRecords = (
    ids: { stack: string; stage: string },
    versions: readonly number[],
  ): Effect.Effect<ReadRecordResult[], StateStoreError> =>
    Effect.all(
      versions.map((version) => readRecord({ ...ids, version })),
      { concurrency: READ_CONCURRENCY },
    ).pipe(
      Effect.map((results) =>
        results.filter(
          (result): result is ReadRecordResult => result !== undefined,
        ),
      ),
    );

  /** Event batch object keys for a version, in replay (seq) order. */
  const listBatchKeys = (request: {
    stack: string;
    stage: string;
    version: number;
  }): Effect.Effect<string[], StateStoreError> =>
    listKeys(eventsPrefix(stagePrefix(request), request.version)).pipe(
      Effect.map((keys) => keys.filter((key) => key.endsWith(".json"))),
    );

  const readBatch = (
    key: string,
  ): Effect.Effect<DeploymentEvent[], StateStoreError> =>
    readText(key).pipe(
      Effect.flatMap((text) =>
        text === undefined
          ? Effect.succeed([])
          : Effect.try({
              try: () => JSON.parse(text) as DeploymentEvent[],
              catch: toError,
            }),
      ),
    );

  const writeBatch = (
    request: { stack: string; stage: string; version: number },
    events: readonly DeploymentEvent[],
  ): Effect.Effect<void, StateStoreError> =>
    withS3((bucket) =>
      s3.putObject({
        Bucket: bucket,
        Key: batchKey(stagePrefix(request), request.version, events[0]!.seq),
        Body: JSON.stringify(events, null, 2),
        ContentType: "application/json",
      }),
    ).pipe(Effect.mapError(toError), Effect.asVoid);

  const store: DeploymentStore = {
    begin: Effect.fn(function* ({ stack, stage, meta, ttlMillis }) {
      const ttl = ttlMillis ?? DEPLOYMENT_TTL_MILLIS;
      const token = yield* Effect.sync(() => crypto.randomUUID());
      const ids = { stack, stage };

      // Claim loop: observe → reconcile stale opens → claim next version
      // with If-None-Match. A conflict means another begin claimed the same
      // version concurrently — re-observe (the winner is now a live open)
      // rather than blindly bumping. No sleeps: conflict resolution is
      // deterministic, and the conformance suite runs under TestClock.
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
        const now = yield* Clock.currentTimeMillis;
        const versions = yield* listVersions(ids);
        const records = yield* readRecords(ids, versions);

        let reconcileConflicted = false;
        for (const { record, etag } of records) {
          if (record.endedAt !== undefined) {
            continue;
          }
          if (isStaleOpen(record, now, ttl)) {
            // Reconcile the lost deployment to "abandoned". If-Match keeps a
            // racing heartbeat/begin from being clobbered; on conflict we
            // re-observe from scratch on the next attempt.
            const result = yield* writeRecord(
              { stack, stage, version: record.version },
              { ...record, endedAt: now, outcome: "abandoned" },
              { etag },
            );
            if (result === "conflict") {
              reconcileConflicted = true;
              break;
            }
          } else {
            return yield* Effect.fail(
              new DeploymentInProgress({
                stack,
                stage,
                holder: toPublicRecord(record),
              }),
            );
          }
        }
        if (reconcileConflicted) {
          continue;
        }

        const version =
          (versions.length === 0 ? 0 : versions[versions.length - 1]!) + 1;
        const stored: StoredDeploymentRecord = {
          stack,
          stage,
          version,
          meta: structuredClone(meta),
          startedAt: now,
          heartbeatAt: now,
          token,
        };
        const claim = yield* writeRecord({ stack, stage, version }, stored, {
          create: true,
        });
        if (claim === "written") {
          return { version, token };
        }
        // Lost the claim race — loop back and re-observe: the winner's open
        // record surfaces as DeploymentInProgress unless it is already
        // stale/ended.
      }
      return yield* Effect.fail(
        toError(
          new Error(
            `could not allocate a deployment version for ${stack}/${stage} after ${CLAIM_ATTEMPTS} claim conflicts`,
          ),
        ),
      );
    }),

    appendEvents: Effect.fn(function* ({
      stack,
      stage,
      version,
      token,
      events,
    }) {
      // Token must match even after `end` — late flushes are accepted.
      yield* requireRecord({ stack, stage, version, token });

      // High-water mark: the max stored seq always lives in the
      // lexicographically-last batch object (see dedupeBatch's invariant).
      const batchKeys = yield* listBatchKeys({ stack, stage, version });
      const maxStoredSeq =
        batchKeys.length === 0
          ? 0
          : maxSeqOf(yield* readBatch(batchKeys[batchKeys.length - 1]!));

      const { retained, ackedSeq } = dedupeBatch(events, maxStoredSeq);
      if (retained.length > 0) {
        yield* writeBatch({ stack, stage, version }, retained);
      }
      return { ackedSeq };
    }),

    heartbeat: Effect.fn(function* ({ stack, stage, version, token }) {
      const now = yield* Clock.currentTimeMillis;
      yield* updateRecord({ stack, stage, version, token }, (record) =>
        // Heartbeat against an ended deployment is a silent no-op.
        record.endedAt === undefined
          ? { ...record, heartbeatAt: now }
          : undefined,
      );
    }),

    end: Effect.fn(function* ({
      stack,
      stage,
      version,
      token,
      outcome,
      summary,
    }) {
      const now = yield* Clock.currentTimeMillis;
      yield* updateRecord({ stack, stage, version, token }, (record) => {
        if (record.endedAt === undefined) {
          return {
            ...record,
            endedAt: now,
            outcome,
            ...(summary !== undefined
              ? { summary: structuredClone(summary) }
              : {}),
          };
        }
        if (record.outcome === "abandoned") {
          // The engine finished after the store reconciled the lost
          // heartbeat — preserve that fact as "completed-late".
          return {
            ...record,
            endedAt: now,
            outcome: "completed-late",
            ...(summary !== undefined
              ? { summary: structuredClone(summary) }
              : {}),
          };
        }
        // Already ended with a real outcome: idempotent no-op.
        return undefined;
      });
    }),

    list: Effect.fn(function* ({ stack, stage, before, limit }) {
      const ids = { stack, stage };
      let versions = (yield* listVersions(ids)).sort((a, b) => b - a);
      if (before !== undefined) {
        versions = versions.filter((version) => version < before);
      }
      if (limit !== undefined) {
        versions = versions.slice(0, limit);
      }
      const records = yield* readRecords(ids, versions);
      return records.map(({ record }) => toPublicRecord(record));
    }),

    get: Effect.fn(function* ({ stack, stage, version }) {
      const found = yield* readRecord({ stack, stage, version });
      return found === undefined ? undefined : toPublicRecord(found.record);
    }),

    readEvents: Effect.fn(function* ({ stack, stage, version, fromSeq }) {
      const found = yield* readRecord({ stack, stage, version });
      if (found === undefined) {
        return yield* Effect.fail(
          new DeploymentNotFound({ stack, stage, version }),
        );
      }
      const keys = yield* listBatchKeys({ stack, stage, version });
      const batches = yield* Effect.all(keys.map(readBatch), {
        concurrency: READ_CONCURRENCY,
      });
      return batches
        .flat()
        .filter((event) => fromSeq === undefined || event.seq >= fromSeq)
        .sort((a, b) => a.seq - b.seq);
    }),
  };

  return store;
};
