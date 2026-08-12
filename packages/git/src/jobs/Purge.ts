/**
 * The delete-purge alarm job (DESIGN.md §2.3 Delete).
 *
 * `DELETE /repos/:o/:r` responds 204 immediately; this job then runs from
 * the Repo DO's alarm until everything is gone:
 *
 * 1. **Registry row** — removed FIRST, freeing the `owner/name` for reuse
 *    right away (the fork pin below never reserves a name).
 * 2. **R2 prefix** — a bounded list+delete loop over `{repoId}/`, but only
 *    while no live fork rows reference this repo (`fork_of` count): forks
 *    reference keys under the parent's prefix by full key (immutable,
 *    shared), so a forked repo's prefix is retained until its forks are
 *    gone.
 * 3. **SQLite** — dropped via `deleteAll` once the pin clears and the
 *    prefix is drained.
 *
 * The job is idempotent and alarm-re-armable: every step tolerates having
 * already run. A single alarm run deletes at most
 * {@link MAX_PAGES_PER_RUN} × 1000 R2 objects and reports `"continue"` so
 * the caller re-arms the alarm instead of blowing the 15-minute budget.
 */
import type { R2Error, ReadWriteBucketClient } from "alchemy/Cloudflare/R2";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { StoreError } from "../git/Store.ts";
import { repoPrefix } from "../store/Keys.ts";

/** R2 `list` pages drained per alarm run (1000 keys per page). */
export const MAX_PAGES_PER_RUN = 10;

/** Outcome of one purge run. */
export type PurgeOutcome =
  | {
      /** Everything is gone (R2 prefix, SQLite, Registry row). */
      readonly _tag: "done";
    }
  | {
      /**
       * More R2 keys remain (or the prefix is fork-pinned); the caller
       * must re-arm the alarm and run again.
       */
      readonly _tag: "continue";
      /** True when the prefix was retained because `fork_count > 0`. */
      readonly forkPinned: boolean;
    };

/** Dependencies of {@link runPurgeJob}. */
export interface PurgeJobOptions {
  /** The repo's ULID (R2 key prefix). */
  readonly repoId: string;
  /** The shared R2 bucket client. */
  readonly bucket: ReadWriteBucketClient;
  /** Reads the current fork count from the Registry. */
  readonly forkCount: Effect.Effect<number, StoreError>;
  /** Drops the DO's entire SQLite/KV state (`storage.deleteAll`). */
  readonly deleteAllStorage: Effect.Effect<void, StoreError>;
  /** Removes the Registry row (FIRST step — frees the name; idempotent). */
  readonly removeRegistryRow: Effect.Effect<void, StoreError>;
}

/** Folds R2 errors into the job's typed error. */
const r2ToStore =
  (what: string) =>
  <A>(
    effect: Effect.Effect<A, R2Error, RuntimeContext>,
  ): Effect.Effect<A, StoreError> =>
    effect.pipe(
      Effect.mapError(
        (error) => new StoreError({ reason: `${what}: ${error.message}` }),
      ),
      Effect.provide(RuntimeContext.phantom),
    );

/**
 * Runs one bounded purge round. The registry row is removed FIRST — the
 * `owner/name` frees immediately, even while forks pin the R2 prefix.
 * Returns `"done"` when the repo is fully gone; `"continue"` when the
 * caller must re-arm the alarm (more R2 keys, or the prefix is pinned by
 * live forks — the DO's SQLite survives until the pin clears so the alarm
 * keeps re-arming with the repoId at hand).
 */
export const runPurgeJob = (
  options: PurgeJobOptions,
): Effect.Effect<PurgeOutcome, StoreError> =>
  Effect.gen(function* () {
    const prefix = repoPrefix(options.repoId);

    // 1. Free the name IMMEDIATELY — even while fork-pinned. The pin only
    //    protects the R2 prefix (forks read shared keys under it); the
    //    `owner/name` must never stay reserved for the lifetime of a fork.
    //    `forkCount` derives from live `fork_of` rows, so it keeps working
    //    after this row is gone. Idempotent across alarm retries.
    yield* options.removeRegistryRow;

    const forks = yield* options.forkCount;
    if (forks > 0) {
      // Fork-retention pin: leave the R2 prefix in place and keep the DO's
      // SQLite (config carries the repoId; jobs row keeps re-arming) until
      // the last fork is purged.
      return { _tag: "continue", forkPinned: true } satisfies PurgeOutcome;
    }

    // 2. Bounded R2 prefix drain.
    let drained = false;
    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const listed = yield* r2ToStore(`R2 list ${prefix}`)(
        options.bucket.list({ prefix, limit: 1000 }),
      );
      if (listed.objects.length > 0) {
        yield* r2ToStore(`R2 delete under ${prefix}`)(
          options.bucket.delete(listed.objects.map((object) => object.key)),
        );
      }
      if (!listed.truncated) {
        drained = true;
        break;
      }
    }
    if (!drained) {
      return { _tag: "continue", forkPinned: false } satisfies PurgeOutcome;
    }

    // 3. Drop the DO's own state (the registry row is already gone — see
    //    step 1; a crash that loses this `deleteAll` is harmless because a
    //    re-created `owner/name` mints a fresh repoId and therefore a fresh
    //    DO, so the stale storage is never addressed again). NOTE: this
    //    wipes the `jobs` table — the caller must not touch SQLite after
    //    this point.
    yield* options.deleteAllStorage;

    return { _tag: "done" } satisfies PurgeOutcome;
  });
