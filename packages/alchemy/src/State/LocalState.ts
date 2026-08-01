import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { decodeFqn, encodeFqn } from "../FQN.ts";
import { recordStateStoreInit } from "../Telemetry/Metrics.ts";
import {
  ClosedVersionHint,
  DEPLOYMENT_TTL_MILLIS,
  DeploymentInProgress,
  DeploymentNotFound,
  DeploymentTokenInvalid,
  endTransition,
  shouldAbandonOpen,
  toPublicRecord,
  type DeploymentEvent,
  type DeploymentStore,
  type StoredDeploymentRecord,
} from "./Deployment.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import {
  fencedWriteRejected,
  State,
  StateStoreError,
  type PersistedState,
  type StateService,
} from "./State.ts";
import { encodeState, reviveState } from "./StateEncoding.ts";

export interface LocalStateOptions {
  /**
   * Directory the `.alchemy` state root is created under.
   * @default process.cwd()
   */
  rootDir?: string;
}

export const localState = (options?: LocalStateOptions) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path
      >();

      const make = makeLocalState(options).pipe(
        recordStateStoreInit,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  );

export const makeLocalState = (options?: LocalStateOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rootDir =
      options?.rootDir ?? (yield* Effect.sync(() => process.cwd()));
    const dotAlchemy = path.join(rootDir, ".alchemy");
    const stateDir = path.join(dotAlchemy, "state");

    const fail = (err: PlatformError) =>
      Effect.fail(
        new StateStoreError({
          message: err.message,
          cause: err,
        }),
      );

    const recover = <T>(
      effect: Effect.Effect<T, PlatformError | StateStoreError, never>,
    ) =>
      effect.pipe(
        Effect.catchTag("PlatformError", (e) =>
          e.reason._tag === "NotFound" ? Effect.void : fail(e),
        ),
      );

    const stageDir = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage);

    const resource = ({
      stack,
      stage,
      fqn,
    }: {
      stack: string;
      stage: string;
      fqn: string;
    }) => path.join(stateDir, stack, stage, `${encodeFqn(fqn)}.json`);

    const outputFile = ({ stack, stage }: { stack: string; stage: string }) =>
      path.join(stateDir, stack, stage, `__stack_output__.json`);

    // Write state files atomically: write to a unique sibling temp file, then
    // rename it over the target. Rename within a directory is atomic on POSIX
    // filesystems, so a concurrent `get` (e.g. a parallel test reading shared
    // `.alchemy/state`) never observes a truncated, mid-write file — which
    // would otherwise surface as `JSON.parse("")` → "Unexpected end of JSON
    // input". The temp suffix is unique per process+call so concurrent writers
    // of the same file don't clobber each other's temp.
    const writeAtomic = (file: string, contents: string) =>
      Effect.suspend(() => {
        const tmp = `${file}.${process.pid}.${Math.random()
          .toString(36)
          .slice(2)}.tmp`;
        return fs.writeFileString(tmp, contents).pipe(
          Effect.flatMap(() => fs.rename(tmp, file)),
          Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)),
        );
      });

    // Parse a state file, tolerating an empty read. A zero-length file can
    // linger from a write that was interrupted before this atomic-write change
    // (or any non-atomic external writer); treat it as "absent" rather than
    // throwing a JSON parse error that would abort the whole operation.
    const parseState = (contents: string) =>
      contents.trim().length === 0
        ? undefined
        : JSON.parse(contents, reviveState);

    const created = new Set<string>();

    const ensure = (dir: string) =>
      created.has(dir)
        ? Effect.succeed(void 0)
        : fs
            .makeDirectory(dir, { recursive: true })
            .pipe(Effect.tap(() => Effect.sync(() => created.add(dir))));

    // ---------------------------------------------------------------------
    // Deployment history (DeploymentStore)
    //
    // Layout (reserved `.deployments` dir inside the stage dir — `list()`
    // filters stage entries to `*.json` files, so it never shows up as a
    // resource):
    //
    //   {stage}/.deployments/{version}.record.json   — DeploymentRecord + token
    //   {stage}/.deployments/{version}.events.jsonl  — one JSON event per line
    //
    // The record file doubles as BOTH the version marker and the atomic
    // version-claim: `begin` creates it with the exclusive flag (`wx`), so
    // two racing begins can never claim the same version (rename overwrites
    // on POSIX and can NOT arbitrate). Keeping it flat (no per-version dir)
    // closes the window where a version directory exists before its record
    // does. After the claim, all record rewrites go through `writeAtomic`
    // (temp + rename), so readers never see a torn update.
    // ---------------------------------------------------------------------

    type Loc = { stack: string; stage: string };

    const deploymentsDir = (loc: Loc) =>
      path.join(stageDir(loc), ".deployments");

    /**
     * Blind-claim fast-path hint — see {@link ClosedVersionHint} for the
     * invariant and the shared single-shot / monotonic policy. Here the
     * claim primitive is an exclusive-create (`wx`) of N+1's record,
     * skipping the O(history) record scan.
     */
    const closedHint = new ClosedVersionHint();

    const recordFile = (loc: Loc, version: number) =>
      path.join(deploymentsDir(loc), `${version}.record.json`);

    const eventsFile = (loc: Loc, version: number) =>
      path.join(deploymentsDir(loc), `${version}.events.jsonl`);

    /** Read a file's contents, mapping NotFound to `undefined`. */
    const readOptional = (file: string) =>
      fs
        .readFileString(file)
        .pipe(
          Effect.catchTag("PlatformError", (e) =>
            e.reason._tag === "NotFound" ? Effect.succeed(undefined) : fail(e),
          ),
        );

    /** Version numbers present for `(stack, stage)`, unsorted. */
    const listVersions = (loc: Loc) =>
      fs.readDirectory(deploymentsDir(loc)).pipe(
        Effect.catchTag("PlatformError", (e) =>
          e.reason._tag === "NotFound"
            ? Effect.succeed([] as string[])
            : fail(e),
        ),
        Effect.map((entries) =>
          entries
            .map((entry) => /^(\d+)\.record\.json$/.exec(entry)?.[1])
            .filter((version): version is string => version !== undefined)
            .map(Number),
        ),
      );

    /**
     * Read a stored deployment record. `undefined` means the version does
     * not exist (the record file IS the version marker).
     *
     * The initial `wx` claim write is not atomic w.r.t. content — a
     * concurrent reader can observe the file existing but still empty for a
     * tick. Yield and re-read a bounded number of times; a permanently
     * empty/torn record (crash between open and write of the claim) is
     * treated as garbage after the budget — safe, because `begin` never
     * returned that version to anyone.
     */
    const readStoredRecord = Effect.fn(function* (loc: Loc, version: number) {
      for (let attempt = 0; attempt < 25; attempt++) {
        const contents = yield* readOptional(recordFile(loc, version));
        if (contents === undefined) {
          return undefined;
        }
        const parsed = yield* Effect.sync(() => {
          try {
            return JSON.parse(contents) as StoredDeploymentRecord;
          } catch {
            return undefined;
          }
        });
        if (parsed !== undefined) {
          return parsed;
        }
        yield* Effect.yieldNow;
      }
      return undefined;
    });

    /** Look up a version and enforce the caller's token. */
    const resolveStored = Effect.fn(function* (
      loc: Loc,
      version: number,
      token: string,
    ) {
      const stored = yield* readStoredRecord(loc, version);
      if (stored === undefined) {
        return yield* Effect.fail(new DeploymentNotFound({ ...loc, version }));
      }
      if (stored.token !== token) {
        return yield* Effect.fail(
          new DeploymentTokenInvalid({ ...loc, version }),
        );
      }
      return stored;
    });

    const writeRecord = (
      loc: Loc,
      version: number,
      record: StoredDeploymentRecord,
    ) =>
      writeAtomic(
        recordFile(loc, version),
        JSON.stringify(record, null, 2),
      ).pipe(Effect.catchTag("PlatformError", fail));

    /**
     * Parse an events.jsonl body. Skips blank and unparseable lines (a
     * crash mid-append can leave a torn trailing line — it must not poison
     * history) and dedupes by seq (first write wins).
     */
    const parseEventLines = (raw: string): DeploymentEvent[] => {
      const events: DeploymentEvent[] = [];
      const seen = new Set<number>();
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        let event: DeploymentEvent;
        try {
          event = JSON.parse(line) as DeploymentEvent;
        } catch {
          continue;
        }
        if (!seen.has(event.seq)) {
          seen.add(event.seq);
          events.push(event);
        }
      }
      return events;
    };

    const deployments: DeploymentStore = {
      begin: ({ stack, stage, meta, ttlMillis, supersede }) =>
        Effect.gen(function* () {
          const loc: Loc = { stack, stage };
          const now = yield* Clock.currentTimeMillis;
          const token = yield* Effect.sync(() => crypto.randomUUID());
          const ttl = ttlMillis ?? DEPLOYMENT_TTL_MILLIS;
          yield* fs
            .makeDirectory(deploymentsDir(loc), { recursive: true })
            .pipe(Effect.catchTag("PlatformError", fail));

          const makeRecord = (version: number): StoredDeploymentRecord => ({
            stack,
            stage,
            version,
            meta,
            startedAt: now,
            heartbeatAt: now,
            token,
          });

          // Blind-claim fast path: our own `end` closed version `known`,
          // so an exclusive-create of known+1 succeeding proves no newer
          // version (and no live open) exists — skip the record scan.
          // `take` is single-shot: a conflict falls through to the loop.
          const known =
            supersede === undefined ? closedHint.take(loc) : undefined;
          if (known !== undefined) {
            const version = known + 1;
            const claimed = yield* fs
              .writeFileString(
                recordFile(loc, version),
                JSON.stringify(makeRecord(version), null, 2),
                { flag: "wx" },
              )
              .pipe(
                Effect.map(() => true),
                Effect.catchTag("PlatformError", (e) =>
                  e.reason._tag === "AlreadyExists"
                    ? Effect.succeed(false)
                    : fail(e),
                ),
              );
            if (claimed) {
              return { version, token };
            }
            // Someone else claimed known+1 — fall through to the full loop.
          }

          const attempt = (
            remaining: number,
          ): Effect.Effect<
            { version: number; token: string },
            DeploymentInProgress | StateStoreError
          > =>
            Effect.gen(function* () {
              if (remaining <= 0) {
                return yield* Effect.fail(
                  new StateStoreError({
                    message: `unable to claim a deployment version for ${stack}/${stage}`,
                  }),
                );
              }
              // Observe: scan existing versions, reconcile stale opens,
              // fail on a live open, derive the next version.
              const versions = yield* listVersions(loc);
              let next = 1;
              for (const version of versions) {
                if (version >= next) {
                  next = version + 1;
                }
                const stored = yield* readStoredRecord(loc, version);
                if (stored === undefined || stored.endedAt !== undefined) {
                  continue;
                }
                // Shared takeover semantics: stale heartbeat, or a targeted
                // `supersede` of exactly this version.
                if (shouldAbandonOpen(stored, now, ttl, supersede)) {
                  stored.endedAt = now;
                  stored.outcome = "abandoned";
                  yield* writeRecord(loc, version, stored);
                } else {
                  return yield* Effect.fail(
                    new DeploymentInProgress({
                      stack,
                      stage,
                      holder: toPublicRecord(stored),
                    }),
                  );
                }
              }
              // Claim: exclusive-create of the record file arbitrates the
              // race. The loser re-scans — it either finds the winner's
              // live open (DeploymentInProgress) or claims next + 1.
              return yield* fs
                .writeFileString(
                  recordFile(loc, next),
                  JSON.stringify(makeRecord(next), null, 2),
                  { flag: "wx" },
                )
                .pipe(
                  Effect.map(() => ({ version: next, token })),
                  Effect.catchTag("PlatformError", (e) =>
                    e.reason._tag === "AlreadyExists"
                      ? attempt(remaining - 1)
                      : fail(e),
                  ),
                );
            });

          return yield* attempt(16);
        }),
      appendEvents: ({ stack, stage, version, token, events }) =>
        Effect.gen(function* () {
          const loc: Loc = { stack, stage };
          yield* resolveStored(loc, version, token);
          // Single writer per version (enforced by the token), so
          // read-dedupe-append is safe without a lock.
          const raw = yield* readOptional(eventsFile(loc, version));
          const existing = yield* Effect.sync(() => parseEventLines(raw ?? ""));
          const seqs = new Set(existing.map((event) => event.seq));
          const fresh: DeploymentEvent[] = [];
          for (const event of events) {
            if (!seqs.has(event.seq)) {
              seqs.add(event.seq);
              fresh.push(event);
            }
          }
          if (fresh.length > 0) {
            // If a crash left a torn trailing line (no newline), start on a
            // fresh line so the new events stay parseable.
            const needsLeadingNewline =
              raw !== undefined && raw.length > 0 && !raw.endsWith("\n");
            const chunk =
              (needsLeadingNewline ? "\n" : "") +
              fresh.map((event) => JSON.stringify(event)).join("\n") +
              "\n";
            yield* fs
              .writeFileString(eventsFile(loc, version), chunk, { flag: "a" })
              .pipe(Effect.catchTag("PlatformError", fail));
          }
          let ackedSeq = 0;
          for (const seq of seqs) {
            if (seq > ackedSeq) {
              ackedSeq = seq;
            }
          }
          return { ackedSeq };
        }),
      heartbeat: ({ stack, stage, version, token }) =>
        Effect.gen(function* () {
          const loc: Loc = { stack, stage };
          const now = yield* Clock.currentTimeMillis;
          const stored = yield* resolveStored(loc, version, token);
          // Heartbeat against an ended deployment is a silent no-op.
          if (stored.endedAt === undefined) {
            stored.heartbeatAt = now;
            yield* writeRecord(loc, version, stored);
          }
        }),
      end: ({ stack, stage, version, token, outcome, summary }) =>
        Effect.gen(function* () {
          const loc: Loc = { stack, stage };
          const now = yield* Clock.currentTimeMillis;
          const stored = yield* resolveStored(loc, version, token);
          // Shared close semantics: first outcome wins, ending an
          // "abandoned" version records "completed-late".
          const nextOutcome = endTransition(stored, outcome);
          if (nextOutcome !== undefined) {
            stored.endedAt = now;
            stored.outcome = nextOutcome;
            if (summary !== undefined) {
              stored.summary = summary;
            }
            yield* writeRecord(loc, version, stored);
          }
          // Feed the blind-claim fast path: this version is known closed.
          closedHint.noteClosed(loc, version);
        }),
      list: ({ stack, stage, before, limit }) =>
        Effect.gen(function* () {
          const loc: Loc = { stack, stage };
          let versions = (yield* listVersions(loc)).sort((a, b) => b - a);
          if (before !== undefined) {
            versions = versions.filter((version) => version < before);
          }
          if (limit !== undefined) {
            versions = versions.slice(0, limit);
          }
          const records = yield* Effect.all(
            versions.map((version) => readStoredRecord(loc, version)),
            { concurrency: 8 },
          );
          return records.flatMap((record) =>
            record === undefined ? [] : [toPublicRecord(record)],
          );
        }),
      get: ({ stack, stage, version }) =>
        Effect.gen(function* () {
          const stored = yield* readStoredRecord({ stack, stage }, version);
          return stored === undefined ? undefined : toPublicRecord(stored);
        }),
      readEvents: ({ stack, stage, version, fromSeq }) =>
        Effect.gen(function* () {
          const loc: Loc = { stack, stage };
          const stored = yield* readStoredRecord(loc, version);
          if (stored === undefined) {
            return yield* Effect.fail(
              new DeploymentNotFound({ stack, stage, version }),
            );
          }
          const raw = yield* readOptional(eventsFile(loc, version));
          const events = yield* Effect.sync(() => parseEventLines(raw ?? ""));
          return events
            .filter((event) =>
              fromSeq === undefined ? true : event.seq >= fromSeq,
            )
            .sort((a, b) => a.seq - b.seq);
        }),
    };

    /**
     * Fencing check (see StateWriteFence in State.ts): reject a write
     * carrying `fence: F` once any deployment version > F exists for the
     * stage. The version directory read is cheap locally. Check-then-write
     * (not atomic with the write), so fencing is best-effort here — a
     * zombie that lost its lease is caught by its next write.
     */
    const checkFence = (request: {
      stack: string;
      stage: string;
      fence?: number;
    }): Effect.Effect<void, StateStoreError> =>
      Effect.gen(function* () {
        if (request.fence === undefined) {
          return;
        }
        const versions = yield* listVersions({
          stack: request.stack,
          stage: request.stage,
        });
        const newest = versions.reduce((max, v) => (v > max ? v : max), 0);
        if (newest > request.fence) {
          return yield* Effect.fail(
            fencedWriteRejected({
              stack: request.stack,
              stage: request.stage,
              fence: request.fence,
            }),
          );
        }
      });

    const state: StateService = {
      id: "local",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        fs.readDirectory(stateDir).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      listStages: (stack: string) =>
        fs.readDirectory(path.join(stateDir, stack)).pipe(
          recover,
          Effect.map((files) => files ?? []),
        ),
      get: (request) =>
        fs.readFile(resource(request)).pipe(
          Effect.map((file) => parseState(file.toString())),
          recover,
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
        checkFence(request).pipe(
          Effect.flatMap(() => ensure(stageDir(request))),
          Effect.flatMap(() =>
            writeAtomic(
              resource(request),
              JSON.stringify(encodeState(request.value), null, 2),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
      delete: (request) =>
        checkFence(request).pipe(
          Effect.flatMap(() => fs.remove(resource(request)).pipe(recover)),
          Effect.asVoid,
        ),
      deleteStack: ({ stack, stage }) =>
        fs
          .remove(
            stage === undefined
              ? path.join(stateDir, stack)
              : stageDir({ stack, stage }),
            { recursive: true },
          )
          .pipe(recover),
      list: (request) =>
        fs.readDirectory(stageDir(request)).pipe(
          recover,
          Effect.map((files) =>
            (files ?? [])
              // Only decode committed state files. Exclude:
              //  - the `__stack_output__.json` bookkeeping file — `decodeFqn`
              //    turns `__` into `/`, which would slip the literal name past
              //    a bare-name filter and make the engine look up a
              //    non-existent resource;
              //  - in-flight `*.tmp` files written by `writeAtomic` (and any
              //    other non-`.json` entry), which are not resources.
              .filter(
                (file) =>
                  file.endsWith(".json") && file !== "__stack_output__.json",
              )
              .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
          ),
        ),
      getOutput: (request) =>
        fs.readFile(outputFile(request)).pipe(
          Effect.map((file) => parseState(file.toString())),
          recover,
        ),
      setOutput: (request) =>
        checkFence(request).pipe(
          Effect.flatMap(() => ensure(stageDir(request))),
          Effect.flatMap(() =>
            writeAtomic(
              outputFile(request),
              JSON.stringify(encodeState(request.value as any), null, 2),
            ),
          ),
          recover,
          Effect.map(() => request.value),
        ),
      getAll: (request) =>
        Effect.gen(function* () {
          const fqns = yield* state.list(request);
          const entries = yield* Effect.all(
            fqns.map((fqn) =>
              state
                .get({ ...request, fqn })
                .pipe(Effect.map((value) => [fqn, value] as const)),
            ),
            { concurrency: 8 },
          );
          const all = new Map<string, PersistedState>();
          for (const [fqn, value] of entries) {
            if (value !== undefined) {
              all.set(fqn, value);
            }
          }
          return all;
        }),
      deployments,
    };
    return state;
  });
