import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import {
  ClosedVersionHint,
  DEPLOYMENT_TTL_MILLIS,
  DeploymentInProgress,
  DeploymentNotFound,
  DeploymentTokenInvalid,
  endTransition,
  shouldAbandonOpen,
  maxSeqOf,
  toPublicRecord,
  type DeploymentEvent,
  type DeploymentStore,
  type StoredDeploymentRecord,
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
 * Request-efficiency invariants:
 *
 * - Version discovery LISTs with `Delimiter: "/"` and reads
 *   `CommonPrefixes`, so event objects are never enumerated — one list
 *   entry per version regardless of journal size.
 * - Only the newest version can be open (a version is claimed only after
 *   every prior open was observed closed or reconciled), so `begin`
 *   decides liveness with a single GET of the newest record.
 * - `appendEvents` caches the journal's high-water mark and the proven
 *   token per `(stack, stage, version)` in the store instance, so
 *   steady-state appends are a single PUT. The cold-cache path (fresh
 *   process resuming a journal) pays one LIST + one GET to re-derive the
 *   high-water mark from the lexicographically-last batch object.
 * - `begin` has a blind-claim fast path: after our own `end` closed
 *   version N, a conditional create of N+1 succeeding proves no newer
 *   version — and therefore no live open — exists (versions are contiguous
 *   and never deleted), so a warm-instance begin is a single PUT. Any
 *   conflict falls back to the full observe → reconcile → claim loop.
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

const VERSION_PREFIX_RE = /^(\d{8})\/$/;

/**
 * Extract the version from a `CommonPrefixes` entry of a
 * `Delimiter: "/"` list under the deployments prefix (e.g.
 * `{deploymentsPrefix}00000003/`), or `undefined` for foreign prefixes.
 */
export const versionFromCommonPrefix = (
  deploymentsKeyPrefix: string,
  prefix: string,
): number | undefined => {
  if (!prefix.startsWith(deploymentsKeyPrefix)) {
    return undefined;
  }
  const match = VERSION_PREFIX_RE.exec(
    prefix.slice(deploymentsKeyPrefix.length),
  );
  return match === null ? undefined : Number.parseInt(match[1]!, 10);
};

export const encodeRecord = (record: StoredDeploymentRecord): string =>
  JSON.stringify(record, null, 2);

export const decodeRecord = (text: string): StoredDeploymentRecord =>
  JSON.parse(text) as StoredDeploymentRecord;

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

  // ---------------------------------------------------------------------
  // Per-instance caches. The open token has exactly one holder (the engine
  // process that called `begin`), so while our heartbeat is live nobody
  // else writes this version's record and nobody else appends to its
  // journal. That makes our own last read/write of `record.json` (plus its
  // ETag) and our own high-water mark authoritative — steady-state
  // heartbeat/end/append are each a single conditional PUT. Every cache is
  // only an optimization: the If-Match guard still arbitrates, and a
  // conflict (someone reconciled us to "abandoned") drops the cache and
  // falls back to read-modify-write.
  // ---------------------------------------------------------------------
  const stageKey = (ids: { stack: string; stage: string }) =>
    `${ids.stack}\u0000${ids.stage}`;
  const versionKey = (ids: { stack: string; stage: string }, version: number) =>
    `${stageKey(ids)}\u0000${version}`;
  /** versionKey → the record + ETag from our own latest read or write. */
  const recordCache = new Map<string, ReadRecordResult>();
  /** versionKey → highest seq known stored in the journal. */
  const highWaterMarks = new Map<string, number>();
  /**
   * Blind-claim fast-path hint — see {@link ClosedVersionHint} for the
   * invariant and the shared single-shot / monotonic policy. Here the
   * claim primitive is a conditional PUT (If-None-Match), turning a warm
   * steady-state begin into a single PUT instead of LIST + GET + PUT.
   */
  const closedHint = new ClosedVersionHint();

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
   * so callers can re-observe instead of failing. On success, returns the
   * written object's ETag — the If-Match guard for the NEXT write, so a
   * writer that owns the latest write never needs to re-read the record.
   */
  const writeRecord = (
    request: { stack: string; stage: string; version: number },
    record: StoredDeploymentRecord,
    condition: { create: true } | { etag: string | undefined },
  ): Effect.Effect<
    { etag: string | undefined } | "conflict",
    StateStoreError
  > =>
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
          Effect.map((result) => ({ etag: result.ETag })),
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
   * OCC read-modify-write of `record.json`, served from {@link recordCache}
   * when warm: the token holder is this record's only writer while its
   * heartbeat is live, so the record + ETag from our own last write are
   * authoritative and the read is skipped — heartbeat/end become a single
   * conditional PUT. An If-Match rejection (e.g. a concurrent `begin`
   * reconciled this record to "abandoned" after our heartbeat went stale)
   * invalidates the cache; the loop re-reads and re-applies. `update`
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
      const cacheKey = versionKey(request, request.version);
      for (let attempt = 0; attempt < UPDATE_ATTEMPTS; attempt++) {
        let found = attempt === 0 ? recordCache.get(cacheKey) : undefined;
        if (found === undefined) {
          found = yield* requireRecord(request);
        } else if (found.record.token !== request.token) {
          // The token is immutable for a version's lifetime, so the cached
          // copy is authoritative for rejection too.
          return yield* Effect.fail(
            new DeploymentTokenInvalid({
              stack: request.stack,
              stage: request.stage,
              version: request.version,
            }),
          );
        }
        const next = update(found.record);
        if (next === undefined) {
          return;
        }
        const result = yield* writeRecord(request, next, {
          etag: found.etag,
        });
        if (result !== "conflict") {
          if (result.etag !== undefined) {
            recordCache.set(cacheKey, { record: next, etag: result.etag });
          }
          return;
        }
        // Lost the OCC race — drop the cache, loop back, re-read, re-apply.
        recordCache.delete(cacheKey);
      }
      return yield* Effect.fail(
        toError(
          new Error(
            `deployment record update for ${request.stack}/${request.stage} v${request.version} kept conflicting`,
          ),
        ),
      );
    });

  /**
   * Version numbers under the deployments prefix, ascending.
   *
   * Lists with `Delimiter: "/"` so S3 rolls each version directory up into
   * one `CommonPrefixes` entry — event batch objects are never enumerated,
   * keeping this O(versions), not O(versions × batches).
   */
  const listVersions = (ids: {
    stack: string;
    stage: string;
  }): Effect.Effect<number[], StateStoreError> => {
    const keyPrefix = deploymentsPrefix(stagePrefix(ids));
    return withS3((bucket) =>
      s3.listObjectsV2
        .pages({
          Bucket: bucket,
          Prefix: keyPrefix,
          Delimiter: "/",
        })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.CommonPrefixes ?? []),
          ),
          Stream.map((common) =>
            common.Prefix === undefined
              ? undefined
              : versionFromCommonPrefix(keyPrefix, common.Prefix),
          ),
          Stream.filter((version): version is number => version !== undefined),
          Stream.runCollect,
          Effect.map((versions) => Array.from(versions).sort((a, b) => a - b)),
        ),
    ).pipe(Effect.mapError(toError));
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
        // Compact — batches are the write hot path and only machine-read.
        Body: JSON.stringify(events),
        ContentType: "application/json",
      }),
    ).pipe(Effect.mapError(toError), Effect.asVoid);

  const store: DeploymentStore = {
    begin: Effect.fn(function* ({ stack, stage, meta, ttlMillis, supersede }) {
      const ttl = ttlMillis ?? DEPLOYMENT_TTL_MILLIS;
      const token = yield* Effect.sync(() => crypto.randomUUID());
      const ids = { stack, stage };

      const makeRecord = (
        version: number,
        now: number,
      ): StoredDeploymentRecord => ({
        stack,
        stage,
        version,
        meta: structuredClone(meta),
        startedAt: now,
        heartbeatAt: now,
        token,
      });

      const seedCaches = (
        version: number,
        stored: StoredDeploymentRecord,
        etag: string | undefined,
      ) => {
        // We are now this version's sole writer, so the first
        // heartbeat/append can skip the read entirely.
        if (etag !== undefined) {
          recordCache.set(versionKey(ids, version), { record: stored, etag });
        }
        highWaterMarks.set(versionKey(ids, version), 0);
        // The newest version is now open — the fast path only applies
        // after our own `end` closes it again.
        closedHint.invalidate(ids);
      };

      // Blind-claim fast path: when our own `end` closed version N, a
      // conditional create of N+1 succeeding proves no newer version (and
      // therefore no live open) exists. `take` is single-shot, so any
      // conflict falls through to the full observe loop below.
      const known = supersede === undefined ? closedHint.take(ids) : undefined;
      if (known !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        const version = known + 1;
        const stored = makeRecord(version, now);
        const claim = yield* writeRecord({ stack, stage, version }, stored, {
          create: true,
        });
        if (claim !== "conflict") {
          seedCaches(version, stored, claim.etag);
          return { version, token };
        }
      }

      // Claim loop: observe → reconcile a stale open → claim next version
      // with If-None-Match. A conflict means another begin claimed the same
      // version concurrently — re-observe (the winner is now a live open)
      // rather than blindly bumping. No sleeps: conflict resolution is
      // deterministic, and the conformance suite runs under TestClock.
      //
      // Only the NEWEST version can be open: a version is claimed only
      // after every prior open was observed closed or reconciled, and ends
      // are permanent (heartbeat/end never reopen a closed record). So a
      // single GET of the newest record decides liveness — no O(history)
      // record scan.
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
        const now = yield* Clock.currentTimeMillis;
        const versions = yield* listVersions(ids);
        const newestVersion =
          versions.length === 0 ? undefined : versions[versions.length - 1]!;
        const newest =
          newestVersion === undefined
            ? undefined
            : yield* readRecord({ ...ids, version: newestVersion });

        if (newest !== undefined && newest.record.endedAt === undefined) {
          const { record, etag } = newest;
          // Shared takeover semantics: stale heartbeat, or a targeted
          // `supersede` of exactly this version. The If-Match reconcile
          // below keeps even the takeover honest — if the "dead" holder
          // races a heartbeat in, the write conflicts and we re-observe.
          if (!shouldAbandonOpen(record, now, ttl, supersede)) {
            return yield* Effect.fail(
              new DeploymentInProgress({
                stack,
                stage,
                holder: toPublicRecord(record),
              }),
            );
          }
          // Reconcile the lost deployment to "abandoned". If-Match keeps a
          // racing heartbeat/begin from being clobbered; on conflict we
          // re-observe from scratch on the next attempt.
          const result = yield* writeRecord(
            { stack, stage, version: record.version },
            { ...record, endedAt: now, outcome: "abandoned" },
            { etag },
          );
          if (result === "conflict") {
            continue;
          }
        }

        const version = (newestVersion ?? 0) + 1;
        const stored = makeRecord(version, now);
        const claim = yield* writeRecord({ stack, stage, version }, stored, {
          create: true,
        });
        if (claim !== "conflict") {
          seedCaches(version, stored, claim.etag);
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
      const cacheKey = versionKey({ stack, stage }, version);

      // Token must match even after `end` — late flushes are accepted.
      // The token is immutable for a version's lifetime, so a cached record
      // (from our own begin/heartbeat/read) settles the check without a GET.
      const cached = recordCache.get(cacheKey);
      if (cached === undefined) {
        recordCache.set(
          cacheKey,
          yield* requireRecord({ stack, stage, version, token }),
        );
      } else if (cached.record.token !== token) {
        return yield* Effect.fail(
          new DeploymentTokenInvalid({ stack, stage, version }),
        );
      }

      // High-water mark: served from cache in the steady state. On a cold
      // cache, the max stored seq always lives in the lexicographically-last
      // batch object (see dedupeBatch's invariant), so one LIST + one GET
      // re-derives it.
      let maxStoredSeq = highWaterMarks.get(cacheKey);
      if (maxStoredSeq === undefined) {
        const batchKeys = yield* listBatchKeys({ stack, stage, version });
        maxStoredSeq =
          batchKeys.length === 0
            ? 0
            : maxSeqOf(yield* readBatch(batchKeys[batchKeys.length - 1]!));
      }

      const { retained, ackedSeq } = dedupeBatch(events, maxStoredSeq);
      if (retained.length > 0) {
        yield* writeBatch({ stack, stage, version }, retained);
      }
      highWaterMarks.set(cacheKey, ackedSeq);
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
        // Shared close semantics: first outcome wins, ending an
        // "abandoned" version records "completed-late".
        const nextOutcome = endTransition(record, outcome);
        if (nextOutcome === undefined) {
          return undefined;
        }
        return {
          ...record,
          endedAt: now,
          outcome: nextOutcome,
          ...(summary !== undefined
            ? { summary: structuredClone(summary) }
            : {}),
        };
      });
      // Feed the blind-claim fast path: this version is now known closed.
      closedHint.noteClosed({ stack, stage }, version);
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
      // The existence check and the journal listing are independent — run
      // them concurrently.
      const [found, keys] = yield* Effect.all(
        [
          readRecord({ stack, stage, version }),
          listBatchKeys({ stack, stage, version }),
        ],
        { concurrency: 2 },
      );
      if (found === undefined) {
        return yield* Effect.fail(
          new DeploymentNotFound({ stack, stage, version }),
        );
      }
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
