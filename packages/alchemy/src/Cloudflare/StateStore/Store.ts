import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

import { pipe } from "effect/Function";
import { RuntimeContext } from "../../RuntimeContext.ts";
import {
  DEPLOYMENT_TTL_MILLIS,
  type DeploymentEvent,
  type DeploymentMeta,
  type DeploymentRecord,
  type DeploymentSummary,
} from "../../State/Deployment.ts";
import type {
  ReplacedResourceState,
  ResourceState,
} from "../../State/ResourceState.ts";
import { encodeState } from "../../State/StateEncoding.ts";
import * as Secret from "../SecretsStore/index.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import {
  CREATE_DEPLOYMENT_EVENTS_TABLE,
  DEPLOYMENT_OPEN_PREFIX,
  deploymentCounterKey,
  deploymentOpenKey,
  deploymentRecordKey,
  deploymentStagePrefix,
  INSERT_DEPLOYMENT_EVENT,
  isStaleOpen,
  makeDeploymentCrypto,
  parseDeploymentOpenKey,
  SELECT_DEPLOYMENT_MAX_SEQ,
  selectDeploymentEventsSql,
  sha256Hex,
  toPublicDeploymentRecord,
  type DeploymentAppendResult,
  type DeploymentBeginResult,
  type DeploymentEventRow,
  type DeploymentGetResult,
  type DeploymentListResult,
  type DeploymentMutateResult,
  type DeploymentOpenMarker,
  type DeploymentReadEventsResult,
  type StoredDeploymentRecord,
} from "./Deployments.ts";
import { EncryptionKey } from "./Token.ts";

export default class Store extends DurableObject<Store>()(
  "Store",
  Effect.gen(function* () {
    // Outer (class-level) phase — resolve the binding factory once.
    // The actual secret read happens inside each DO instance below,
    // since `SecretClient.get()` needs the per-instance worker env.
    const encryptionSecret = yield* Secret.ReadSecret(EncryptionKey);
    const state = yield* DurableObjectState;
    const storage = state.storage;

    return Effect.gen(function* () {
      const keyHex = yield* encryptionSecret
        .get()
        .pipe(Effect.map(Redacted.value), Effect.orDie);
      const cryptoKey = yield* Effect.tryPromise(() =>
        crypto.subtle.importKey(
          "raw",
          Buffer.from(keyHex, "hex"),
          { name: "AES-CTR" },
          false,
          ["encrypt", "decrypt"],
        ),
      ).pipe(Effect.orDie);

      const encryptValue = (value: unknown) =>
        Effect.tryPromise(async () => {
          const plaintext = new TextEncoder().encode(
            JSON.stringify(encodeState(value)),
          );
          const counter = crypto.getRandomValues(allocBytes(NONCE_BYTES));
          const ct = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-CTR", counter, length: 64 },
              cryptoKey,
              plaintext,
            ),
          );
          // Frame as a single base64 string: nonce || ciphertext.
          return Buffer.concat([counter, ct]).toString("base64");
        }).pipe(Effect.orDie);

      const decryptEntry = (entry: string) =>
        Effect.tryPromise(async () => {
          const framed = Buffer.from(entry, "base64");
          const counter = framed.subarray(0, NONCE_BYTES);
          const ciphertext = framed.subarray(NONCE_BYTES);
          let pt;
          try {
            pt = await crypto.subtle.decrypt(
              { name: "AES-CTR", counter, length: 64 },
              cryptoKey,
              ciphertext,
            );
          } catch (error) {
            // We return undefined here because in 2.0.0-beta.45, we rotated encryption keys unnecessarily.
            // So, we catch a decryption error here and return undefined instead.
            // The engine should reconcile, hopefully, but users may lose some data
            console.error(
              "Error decrypting entry. Returning undefined instead.",
              error,
            );
            return undefined;
          }
          return JSON.parse(new TextDecoder().decode(pt)) as ResourceState;
        }).pipe(Effect.orDie);

      // -- Deployment history (DeploymentStore backing) --------------
      //
      // Records live in KV under reserved `d\x00`/`dl\x00`/`dc\x00`
      // prefixes; the event journal lives in `storage.sql` rows. Meta /
      // summary / payloads are sealed with the same AES-CTR key as
      // resource rows PLUS an integrity hash — corruption surfaces as a
      // typed result instead of the legacy swallow-undefined behavior.
      const deploymentCrypto = makeDeploymentCrypto(cryptoKey);

      const ensureEventsTable = storage.sql
        .exec(CREATE_DEPLOYMENT_EVENTS_TABLE)
        .pipe(Effect.asVoid);

      const readStoredDeployment = (stage: string, version: number) =>
        storage.get<StoredDeploymentRecord>(
          deploymentRecordKey(stage, version),
        );

      /** Unseal meta/summary and strip internal fields. */
      const toPublicDeployment = (stored: StoredDeploymentRecord) =>
        Effect.gen(function* () {
          const meta = yield* deploymentCrypto.open<DeploymentMeta>(
            stored.meta,
          );
          const summary =
            stored.summary === undefined
              ? undefined
              : yield* deploymentCrypto.open<DeploymentSummary>(stored.summary);
          return toPublicDeploymentRecord(stored, meta, summary);
        });

      return {
        /**
         * (Both DOs) Reconcile TTL-expired open deployments to
         * "abandoned" server-side. `begin` arms the alarm at the open's
         * deadline; the handler closes stale opens across every stage
         * and re-arms itself at the earliest remaining deadline.
         */
        alarm: () =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const markers = yield* storage.list<DeploymentOpenMarker>({
              prefix: DEPLOYMENT_OPEN_PREFIX,
            });
            let next: number | undefined;
            for (const [key, marker] of markers) {
              const stage = parseDeploymentOpenKey(key);
              if (stage === undefined) continue;
              const stored = yield* storage.get<StoredDeploymentRecord>(
                deploymentRecordKey(stage, marker.version),
              );
              if (stored === undefined || stored.endedAt !== undefined) {
                // Orphaned marker (record gone or already closed).
                yield* storage.delete(key);
                continue;
              }
              if (isStaleOpen(stored, now, stored.ttlMillis)) {
                yield* storage.put(deploymentRecordKey(stage, marker.version), {
                  ...stored,
                  endedAt: now,
                  outcome: "abandoned",
                } satisfies StoredDeploymentRecord);
                yield* storage.delete(key);
              } else {
                const deadline = stored.heartbeatAt + stored.ttlMillis;
                next = next === undefined ? deadline : Math.min(next, deadline);
              }
            }
            if (next !== undefined) {
              yield* storage.setAlarm(next);
            }
          }).pipe(Effect.provide(RuntimeContext.phantom)),

        // -- Root DO methods -----------------------------------------

        /**
         * (Root DO only) List every stack name ever registered.
         */
        listStacks: Effect.fn(function* () {
          const entries = yield* storage.list<number>({
            prefix: STACK_INDEX_PREFIX,
          });
          const stacks: string[] = [];
          for (const key of entries.keys()) {
            stacks.push(key.slice(STACK_INDEX_PREFIX.length));
          }
          return stacks;
        }),

        /**
         * (Root DO only) Register a stack name. Idempotent — safe to
         * call on every `set` to the corresponding stack DO.
         */
        registerStack: ({ stack }: { stack: string }) =>
          storage.put(`${STACK_INDEX_PREFIX}${stack}`, 1),

        /**
         * (Root DO only) Remove a stack name from the global index.
         */
        unregisterStack: ({ stack }: { stack: string }) =>
          storage.delete(`${STACK_INDEX_PREFIX}${stack}`),

        // -- Stack DO methods ----------------------------------------

        /** (Stack DO only) List stages with at least one resource. */
        listStages: () =>
          storage
            .list<string>({
              prefix: RESOURCE_PREFIX,
            })
            .pipe(
              Effect.map((entries) => {
                const stages = new Set<string>();
                for (const key of entries.keys()) {
                  const parsed = parseResourceKey(key);
                  if (parsed) stages.add(parsed.stage);
                }
                return [...stages];
              }),
            ),

        /** (Stack DO only) List every resource FQN in a stage. */
        listResources: ({ stage }: { stage: string }) =>
          storage
            .list<string>({
              prefix: stagePrefix(stage),
            })
            .pipe(
              Effect.map((entries) => {
                const fqns: string[] = [];
                for (const key of entries.keys()) {
                  const parsed = parseResourceKey(key);
                  if (parsed) fqns.push(parsed.fqn);
                }
                return fqns;
              }),
            ),

        /**
         * (Stack DO only) Get a resource by (stage, fqn). Returns
         * null if missing.
         */
        get: ({ stage, fqn }: { stage: string; fqn: string }) =>
          storage
            .get<string>(resourceKey(stage, fqn))
            .pipe(
              Effect.flatMap((entry) =>
                entry == null ? Effect.succeed(undefined) : decryptEntry(entry),
              ),
            ),

        /**
         * (Stack DO only) Persist a resource. Returns the stored
         * value unchanged.
         */
        set: ({
          stage,
          fqn,
          value,
        }: {
          stage: string;
          fqn: string;
          value: ResourceState;
        }) =>
          encryptValue(value).pipe(
            Effect.flatMap((encrypted) =>
              storage
                .put<string>(resourceKey(stage, fqn), encrypted)
                .pipe(Effect.asVoid),
            ),
            Effect.map(() => value),
          ),

        /**
         * (Stack DO only) Delete a resource. Idempotent.
         *
         * Exposed as `remove` (not `delete`) because Cloudflare's
         * Durable Object RPC stub reserves `delete` and refuses to
         * proxy the call, surfacing as "RPC receiver does not
         * implement the method 'delete'".
         */
        remove: ({ stage, fqn }: { stage: string; fqn: string }) =>
          storage.delete(resourceKey(stage, fqn)),

        /**
         * (Stack DO only) Delete every resource in this stack, or every
         * resource in a single stage when specified.
         */
        deleteStack: ({ stage }: { stage?: string } = {}) =>
          stage === undefined
            ? storage.deleteAll()
            : storage.list<string>({ prefix: stagePrefix(stage) }).pipe(
                Effect.flatMap((entries) => {
                  const keys = [...entries.keys(), stackOutputKey(stage)];
                  return storage.delete(keys).pipe(Effect.asVoid);
                }),
              ),

        /**
         * (Stack DO only) Read the persisted stack output for `stage`.
         * Returns `undefined` when the stage has not been deployed.
         */
        getOutput: ({ stage }: { stage: string }) =>
          storage
            .get<string>(stackOutputKey(stage))
            .pipe(
              Effect.flatMap((entry) =>
                entry == null ? Effect.succeed(undefined) : decryptEntry(entry),
              ),
            ),

        /**
         * (Stack DO only) Persist the resolved stack output for
         * `stage`. Returns the stored value unchanged.
         */
        setOutput: ({ stage, value }: { stage: string; value: any }) =>
          encryptValue(value).pipe(
            Effect.flatMap((encrypted) =>
              storage
                .put<string>(stackOutputKey(stage), encrypted)
                .pipe(Effect.asVoid),
            ),
            Effect.map(() => value),
          ),

        /**
         * (Stack DO only) Return every resource in a stage whose
         * `status === "replaced"`. Each entry is decrypted so the
         * `status` field can be inspected.
         */
        getReplacedResources: ({ stage }: { stage: string }) =>
          pipe(
            storage.list<string>({ prefix: stagePrefix(stage) }),
            Effect.map((entries) =>
              [...entries.values()].filter((e): e is string => !!e),
            ),
            Effect.flatMap(
              Effect.forEach(decryptEntry, { concurrency: "unbounded" }),
            ),
            Effect.map((decoded) =>
              decoded.filter(
                (d): d is ReplacedResourceState => d?.status === "replaced",
              ),
            ),
          ),

        /**
         * (Stack DO only) Read every resource in a stage in one call —
         * `fqn -> ResourceState`. Batch reader for the dashboard; kills
         * the N+1 `listResources` + per-fqn `get` pattern.
         */
        getAll: ({ stage }: { stage: string }) =>
          pipe(
            storage.list<string>({ prefix: stagePrefix(stage) }),
            Effect.flatMap((entries) =>
              Effect.forEach(
                [...entries.entries()],
                ([key, entry]) =>
                  (entry == null
                    ? Effect.succeed(undefined)
                    : decryptEntry(entry)
                  ).pipe(
                    Effect.map(
                      (state) => [parseResourceKey(key)?.fqn, state] as const,
                    ),
                  ),
                { concurrency: "unbounded" },
              ),
            ),
            Effect.map((pairs) => {
              const all: Record<string, ResourceState> = {};
              for (const [fqn, state] of pairs) {
                if (fqn !== undefined && state !== undefined) {
                  all[fqn] = state;
                }
              }
              return all;
            }),
          ),

        // -- Stack DO deployment history -------------------------------
        //
        // Failures travel back as discriminated result values (not thrown
        // tagged errors): Cloudflare's DO RPC stub serializes thrown
        // errors lossily, so the worker maps these onto the schema-typed
        // HTTP errors instead.

        /**
         * (Stack DO only) Allocate the next version for `(stack, stage)`
         * and open it. Stale opens are reconciled to "abandoned" first;
         * a live open loses the claim and is surfaced as `in-progress`.
         */
        deploymentBegin: Effect.fn(function* ({
          stack,
          stage,
          meta,
          ttlMillis,
        }: {
          stack: string;
          stage: string;
          meta: DeploymentMeta;
          ttlMillis?: number;
        }) {
          const now = yield* Clock.currentTimeMillis;
          const ttl = ttlMillis ?? DEPLOYMENT_TTL_MILLIS;
          const token = yield* Effect.sync(() => crypto.randomUUID());
          // Pre-compute ALL crypto outside the transaction: a non-storage
          // await inside it would open the DO input gate mid-claim.
          const tokenHash = yield* sha256Hex(token);
          const sealedMeta = yield* deploymentCrypto.seal(meta);

          // The version-claim primitive: the DO is single-threaded per
          // stack and `storage.transaction` makes the read-marker /
          // bump-counter / write-record step atomic even across the
          // storage await points, so two racing begins can never both
          // allocate.
          const claim = yield* storage.transaction((txn) =>
            Effect.gen(function* () {
              const open = yield* txn.get<DeploymentOpenMarker>(
                deploymentOpenKey(stage),
              );
              if (open !== undefined) {
                const holder = yield* txn.get<StoredDeploymentRecord>(
                  deploymentRecordKey(stage, open.version),
                );
                if (
                  holder !== undefined &&
                  holder.endedAt === undefined &&
                  !isStaleOpen(holder, now, ttl)
                ) {
                  // Live open — the loser re-checks and fails in-progress.
                  return {
                    _tag: "conflict" as const,
                    version: open.version,
                  };
                }
                if (holder !== undefined && holder.endedAt === undefined) {
                  // Stale open: reconcile to "abandoned" before allocating.
                  yield* txn.put(deploymentRecordKey(stage, open.version), {
                    ...holder,
                    endedAt: now,
                    outcome: "abandoned",
                  } satisfies StoredDeploymentRecord);
                }
                yield* txn.delete(deploymentOpenKey(stage));
              }
              const version =
                ((yield* txn.get<number>(deploymentCounterKey(stage))) ?? 0) +
                1;
              yield* txn.put(deploymentCounterKey(stage), version);
              yield* txn.put(deploymentRecordKey(stage, version), {
                v: 1,
                stack,
                stage,
                version,
                startedAt: now,
                heartbeatAt: now,
                ttlMillis: ttl,
                tokenHash,
                meta: sealedMeta,
              } satisfies StoredDeploymentRecord);
              yield* txn.put(deploymentOpenKey(stage), {
                version,
                deadline: now + ttl,
              } satisfies DeploymentOpenMarker);
              // Server-side stale-open detection: fire at (or before)
              // this open's deadline; the handler reconciles + re-arms.
              const existingAlarm = yield* txn.getAlarm();
              if (existingAlarm === null || existingAlarm > now + ttl) {
                yield* txn.setAlarm(now + ttl);
              }
              return { _tag: "allocated" as const, version };
            }),
          );

          if (claim._tag === "allocated") {
            const ok: DeploymentBeginResult = {
              _tag: "ok",
              version: claim.version,
              token,
            };
            return ok;
          }
          // Lost the claim: surface who holds the stage (sans token).
          const holder = yield* readStoredDeployment(stage, claim.version);
          if (holder === undefined) {
            const corrupt: DeploymentBeginResult = {
              _tag: "corrupt",
              message: `open deployment v${claim.version} has no record`,
            };
            return corrupt;
          }
          const pub = yield* Effect.result(toPublicDeployment(holder));
          const result: DeploymentBeginResult = Result.isSuccess(pub)
            ? { _tag: "in-progress", holder: pub.success }
            : { _tag: "corrupt", message: pub.failure.message };
          return result;
        }),

        /**
         * (Stack DO only) Append a batch of events to a deployment's
         * journal. Idempotent per `seq` via `INSERT OR IGNORE`; appends
         * after `end` are accepted (the token must still match).
         */
        deploymentAppendEvents: Effect.fn(function* ({
          stage,
          version,
          token,
          events,
        }: {
          stage: string;
          version: number;
          token: string;
          events: readonly DeploymentEvent[];
        }) {
          const tokenHash = yield* sha256Hex(token);
          const rows = yield* Effect.forEach(events, (event) =>
            deploymentCrypto.seal(event.payload ?? null).pipe(
              Effect.map((box) => ({
                seq: event.seq,
                ts: event.ts,
                fqn: event.fqn ?? null,
                box,
              })),
            ),
          );
          const stored = yield* readStoredDeployment(stage, version);
          if (stored === undefined) {
            const notFound: DeploymentAppendResult = { _tag: "not-found" };
            return notFound;
          }
          if (stored.tokenHash !== tokenHash) {
            const invalid: DeploymentAppendResult = { _tag: "invalid-token" };
            return invalid;
          }
          yield* ensureEventsTable;
          for (const row of rows) {
            yield* storage.sql.exec(
              INSERT_DEPLOYMENT_EVENT,
              stage,
              version,
              row.seq,
              row.ts,
              row.fqn,
              row.box.hash,
              row.box.data,
            );
          }
          const cursor = yield* storage.sql.exec<{ ackedSeq: number }>(
            SELECT_DEPLOYMENT_MAX_SEQ,
            stage,
            version,
          );
          const acked = yield* cursor.one();
          const ok: DeploymentAppendResult = {
            _tag: "ok",
            ackedSeq: acked.ackedSeq,
          };
          return ok;
        }),

        /**
         * (Stack DO only) Refresh the open marker's heartbeat. Silent
         * no-op once the deployment has ended.
         */
        deploymentHeartbeat: Effect.fn(function* ({
          stage,
          version,
          token,
        }: {
          stage: string;
          version: number;
          token: string;
        }) {
          const now = yield* Clock.currentTimeMillis;
          const tokenHash = yield* sha256Hex(token);
          return yield* storage.transaction((txn) =>
            Effect.gen(function* () {
              const stored = yield* txn.get<StoredDeploymentRecord>(
                deploymentRecordKey(stage, version),
              );
              if (stored === undefined) {
                const notFound: DeploymentMutateResult = { _tag: "not-found" };
                return notFound;
              }
              if (stored.tokenHash !== tokenHash) {
                const invalid: DeploymentMutateResult = {
                  _tag: "invalid-token",
                };
                return invalid;
              }
              const ok: DeploymentMutateResult = { _tag: "ok" };
              if (stored.endedAt !== undefined) {
                // Ended (possibly reconciled to "abandoned"): no-op.
                return ok;
              }
              yield* txn.put(deploymentRecordKey(stage, version), {
                ...stored,
                heartbeatAt: now,
              } satisfies StoredDeploymentRecord);
              const open = yield* txn.get<DeploymentOpenMarker>(
                deploymentOpenKey(stage),
              );
              if (open?.version === version) {
                yield* txn.put(deploymentOpenKey(stage), {
                  version,
                  deadline: now + stored.ttlMillis,
                } satisfies DeploymentOpenMarker);
              }
              return ok;
            }),
          );
        }),

        /**
         * (Stack DO only) Close a deployment. Idempotent — the first
         * outcome wins; ending an "abandoned" version records
         * "completed-late".
         */
        deploymentEnd: Effect.fn(function* ({
          stage,
          version,
          token,
          outcome,
          summary,
        }: {
          stage: string;
          version: number;
          token: string;
          outcome: "succeeded" | "failed" | "interrupted";
          // Readonly-friendly DeploymentSummary: the worker hands us the
          // wire-decoded payload, whose record fields carry readonly
          // index signatures.
          summary?: {
            readonly counts?: Readonly<Record<string, number>>;
            readonly error?: string;
          };
        }) {
          const now = yield* Clock.currentTimeMillis;
          const tokenHash = yield* sha256Hex(token);
          const sealedSummary =
            summary === undefined
              ? undefined
              : yield* deploymentCrypto.seal(summary);
          return yield* storage.transaction((txn) =>
            Effect.gen(function* () {
              const stored = yield* txn.get<StoredDeploymentRecord>(
                deploymentRecordKey(stage, version),
              );
              if (stored === undefined) {
                const notFound: DeploymentMutateResult = { _tag: "not-found" };
                return notFound;
              }
              if (stored.tokenHash !== tokenHash) {
                const invalid: DeploymentMutateResult = {
                  _tag: "invalid-token",
                };
                return invalid;
              }
              const ok: DeploymentMutateResult = { _tag: "ok" };
              if (stored.endedAt === undefined) {
                const next: StoredDeploymentRecord = {
                  ...stored,
                  endedAt: now,
                  outcome,
                };
                if (sealedSummary !== undefined) {
                  next.summary = sealedSummary;
                }
                yield* txn.put(deploymentRecordKey(stage, version), next);
                const open = yield* txn.get<DeploymentOpenMarker>(
                  deploymentOpenKey(stage),
                );
                if (open?.version === version) {
                  yield* txn.delete(deploymentOpenKey(stage));
                }
                return ok;
              }
              if (stored.outcome === "abandoned") {
                // The engine finished after the store reconciled the lost
                // heartbeat — preserve that fact as "completed-late".
                const next: StoredDeploymentRecord = {
                  ...stored,
                  endedAt: now,
                  outcome: "completed-late",
                };
                if (sealedSummary !== undefined) {
                  next.summary = sealedSummary;
                }
                yield* txn.put(deploymentRecordKey(stage, version), next);
              }
              // Already ended with a real outcome: idempotent no-op.
              return ok;
            }),
          );
        }),

        /**
         * (Stack DO only) List deployment records newest-first with
         * strictly-less-than `before` cursor pagination.
         */
        deploymentList: Effect.fn(function* ({
          stage,
          before,
          limit,
        }: {
          stage: string;
          before?: number;
          limit?: number;
        }) {
          const entries = yield* storage.list<StoredDeploymentRecord>({
            prefix: deploymentStagePrefix(stage),
            reverse: true,
            // `end` is exclusive, so this is exactly `version < before`.
            ...(before !== undefined
              ? { end: deploymentRecordKey(stage, before) }
              : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          const records: DeploymentRecord[] = [];
          for (const stored of entries.values()) {
            const pub = yield* Effect.result(toPublicDeployment(stored));
            if (Result.isFailure(pub)) {
              const corrupt: DeploymentListResult = {
                _tag: "corrupt",
                message: pub.failure.message,
              };
              return corrupt;
            }
            records.push(pub.success);
          }
          const ok: DeploymentListResult = { _tag: "ok", records };
          return ok;
        }),

        /**
         * (Stack DO only) Read one deployment record, or undefined.
         */
        deploymentGet: Effect.fn(function* ({
          stage,
          version,
        }: {
          stage: string;
          version: number;
        }) {
          const stored = yield* readStoredDeployment(stage, version);
          if (stored === undefined) {
            const missing: DeploymentGetResult = {
              _tag: "ok",
              record: undefined,
            };
            return missing;
          }
          const pub = yield* Effect.result(toPublicDeployment(stored));
          const result: DeploymentGetResult = Result.isSuccess(pub)
            ? { _tag: "ok", record: pub.success }
            : { _tag: "corrupt", message: pub.failure.message };
          return result;
        }),

        /**
         * (Stack DO only) Read a deployment's journal, seq-ascending,
         * `fromSeq` inclusive.
         */
        deploymentReadEvents: Effect.fn(function* ({
          stage,
          version,
          fromSeq,
        }: {
          stage: string;
          version: number;
          fromSeq?: number;
        }) {
          const stored = yield* readStoredDeployment(stage, version);
          if (stored === undefined) {
            const notFound: DeploymentReadEventsResult = { _tag: "not-found" };
            return notFound;
          }
          yield* ensureEventsTable;
          const cursor = yield* fromSeq === undefined
            ? storage.sql.exec<DeploymentEventRow>(
                selectDeploymentEventsSql(false),
                stage,
                version,
              )
            : storage.sql.exec<DeploymentEventRow>(
                selectDeploymentEventsSql(true),
                stage,
                version,
                fromSeq,
              );
          const rows = yield* cursor.toArray();
          const events: DeploymentEvent[] = [];
          for (const row of rows) {
            const payload = yield* Effect.result(
              deploymentCrypto.open<unknown>({
                hash: row.hash,
                data: row.payload,
              }),
            );
            if (Result.isFailure(payload)) {
              const corrupt: DeploymentReadEventsResult = {
                _tag: "corrupt",
                message: payload.failure.message,
              };
              return corrupt;
            }
            const event: DeploymentEvent = {
              seq: row.seq,
              ts: row.ts,
              payload: payload.success,
            };
            if (row.fqn !== null) {
              event.fqn = row.fqn;
            }
            events.push(event);
          }
          const ok: DeploymentReadEventsResult = { _tag: "ok", events };
          return ok;
        }),
      };
    });
  }).pipe(Effect.provide(Secret.ReadSecretBinding)),
) {
  /**
   * Well-known DO name whose sole job is to track the set of stacks
   * that have ever had resources written. `listStacks` queries it;
   * every `set` asks it to register the stack (idempotent).
   */
  static readonly ROOT_DO_NAME = "__root__" as const;
}

/** NUL byte separator for composite keys. */
const SEP = "\x00";

/** Key prefix for resource entries in a stack DO. */
const RESOURCE_PREFIX = `r${SEP}`;

/** Key prefix for stack-output entries in a stack DO. */
const STACK_OUTPUT_PREFIX = `o${SEP}`;

/** Key prefix for stack-index entries in the root DO. */
const STACK_INDEX_PREFIX = "s:";

/** AES-CTR counter block length. */
const NONCE_BYTES = 16;

/** Build the resource key inside a *stack DO*. */
const resourceKey = (stage: string, fqn: string) =>
  `${RESOURCE_PREFIX}${stage}${SEP}${fqn}`;

/** Prefix matching every resource key inside a specific stage. */
const stagePrefix = (stage: string) => `${RESOURCE_PREFIX}${stage}${SEP}`;

/** Build the stack-output key inside a *stack DO*. */
const stackOutputKey = (stage: string) => `${STACK_OUTPUT_PREFIX}${stage}`;

/**
 * Parse a resource key back into its (stage, fqn) tuple. Returns
 * undefined for keys that do not match the expected shape.
 */
const parseResourceKey = (
  key: string,
): { stage: string; fqn: string } | undefined => {
  if (!key.startsWith(RESOURCE_PREFIX)) return undefined;
  const rest = key.slice(RESOURCE_PREFIX.length);
  const sep = rest.indexOf(SEP);
  if (sep < 0) return undefined;
  return { stage: rest.slice(0, sep), fqn: rest.slice(sep + 1) };
};

/**
 * Allocate a `Uint8Array` over a fresh `ArrayBuffer` (not shared) so
 * the resulting buffer satisfies Web Crypto's `BufferSource` type
 * constraint under strict DOM typings.
 */
const allocBytes = (size: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new ArrayBuffer(size));
