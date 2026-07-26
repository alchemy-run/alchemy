/**
 * The Ledger — the org's BOOK OF RECORD, its own `Context.Service`
 * with per-environment physics (the components doctrine: environments
 * are Layer provide-lists over seams). It holds the durable facts the
 * org itself creates:
 *
 * - **deliveries** (`offer`/`settle`) — the dedupe/liveness seam:
 *   however many times the world re-delivers, exactly one caller sees
 *   `accepted`;
 * - **metadata** (`put`/`get`) — a generic keyed store for
 *   coordination facts born structured in one place and read in
 *   another (e.g. OpenPullRequest records which issue a PR resolves;
 *   the event router looks it up). Key conventions belong to the
 *   CALLERS — the Ledger stays domain-blind.
 *
 * Process implementations only ever `yield* Ledger`; which physics
 * answers is decided entirely at composition:
 *
 * - {@link MemoryLedger} — tests.
 * - {@link SqliteLedger} — the laptop: restart-resume (kill the factory,
 *   restart it, re-polled deliveries collapse against the same file and
 *   coordination metadata survives).
 * - {@link D1Ledger} — Cloudflare: any number of concurrent Worker
 *   instances agree through the D1 transaction, never instance memory.
 *
 * It is deliberately NOT a task queue: no claim/lease, no visibility
 * timeout, no ordering — ordering and per-key serialization are the
 * kernel Layer's job, retry is `Effect.retry` at the call site (see
 * the factory-components design: keep the name Ledger).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { Database as SqliteDatabase } from "bun:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * The answer to an `offer`: `accepted` — first sighting of `(queue,
 * key)`, the caller creates the run (`send`); `duplicate` — already
 * admitted (a webhook redelivery, a poll re-observation, or a live
 * run's conversation moving), the caller steers.
 *
 * OPEN QUESTION (factory-components.md §3.1 finding 2, deliberately
 * not built yet): the canon's re-admission door (settled key ⇒ new
 * fold-seeded run) needs `offer` to report "settled" DISTINCTLY from
 * "duplicate" — a three-valued answer (`accepted | duplicate |
 * settled`). All three physics below already persist settlement, so
 * widening the union is a contract change only; the re-admission test
 * decides it when that slice lands.
 */
export type OfferStatus = "accepted" | "duplicate";

export class Ledger extends Context.Service<
  Ledger,
  {
    /**
     * Transactionally idempotent by `(queue, key)`: however many
     * concurrent instances run this code and however many times the
     * world re-delivers, exactly one caller sees `accepted`.
     */
    offer(
      queue: string,
      key: string,
      task: unknown,
    ): Effect.Effect<{ status: OfferStatus }>;
    /**
     * Record that the run for `(queue, key)` settled (the world closed
     * the work). Idempotent no-op for an unknown key — the
     * delete-idempotency doctrine, same as resource `delete`.
     */
    settle(queue: string, key: string): Effect.Effect<void>;
    /**
     * Stash a coordination fact under `key` (last write wins). JSON
     * values only — the store is durable and environment-portable.
     */
    put(key: string, value: unknown): Effect.Effect<void>;
    /** The fact under `key`, when the org has one on record. */
    get(key: string): Effect.Effect<unknown>;
  }
>()("alchemy-org/Ledger") {}

// ─── memory: tests ─────────────────────────────────────────────────

export const MemoryLedger: Layer.Layer<Ledger> = Layer.sync(Ledger, () => {
  const rows = new Map<string, "open" | "settled">();
  const meta = new Map<string, unknown>();
  const rowKey = (queue: string, key: string) => `${queue}\u0000${key}`;
  return Ledger.of({
    offer: (queue, key, _task) =>
      Effect.sync(() => {
        const id = rowKey(queue, key);
        if (rows.has(id)) return { status: "duplicate" as const };
        rows.set(id, "open");
        return { status: "accepted" as const };
      }),
    settle: (queue, key) =>
      Effect.sync(() => {
        const id = rowKey(queue, key);
        if (rows.has(id)) rows.set(id, "settled");
      }),
    put: (key, value) => Effect.sync(() => void meta.set(key, value)),
    get: (key) => Effect.sync(() => meta.get(key)),
  });
});

// ─── sqlite: the laptop (restart-resume) ───────────────────────────

const LEDGER_TABLE = `
  CREATE TABLE IF NOT EXISTS ledger (
    queue      TEXT NOT NULL,
    key        TEXT NOT NULL,
    task       TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
    PRIMARY KEY (queue, key)
  )
`;

const META_TABLE = `
  CREATE TABLE IF NOT EXISTS meta (
    key    TEXT NOT NULL PRIMARY KEY,
    value  TEXT NOT NULL
  )
`;

/**
 * bun:sqlite physics. `INSERT OR IGNORE` against the `(queue, key)`
 * primary key is the transaction: the row count says whether THIS
 * offer was the first. Deterministic delivery/identity keys make the
 * dedupe hold across process restarts over the same file.
 */
export const SqliteLedger = (path: string): Layer.Layer<Ledger> =>
  Layer.effect(
    Ledger,
    Effect.gen(function* () {
      // bun:sqlite is synchronous — every call is wrapped so it
      // participates in the Effect runtime (tracing, error channels)
      const db = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const database = new SqliteDatabase(path, { create: true });
            database.run(LEDGER_TABLE);
            database.run(META_TABLE);
            return database;
          },
          catch: (cause) =>
            new Error(`SqliteLedger failed to open ${path}: ${cause}`),
        }).pipe(Effect.orDie),
        (database) => Effect.sync(() => database.close()),
      );

      return Ledger.of({
        offer: (queue, key, task) =>
          Effect.sync(() => {
            const result = db
              .query(
                "INSERT OR IGNORE INTO ledger (queue, key, task) VALUES (?, ?, ?)",
              )
              .run(queue, key, JSON.stringify(task ?? null));
            return {
              status:
                result.changes > 0
                  ? ("accepted" as const)
                  : ("duplicate" as const),
            };
          }),
        settle: (queue, key) =>
          Effect.sync(() => {
            // unknown key ⇒ zero rows updated ⇒ idempotent no-op
            db.query(
              "UPDATE ledger SET status = 'settled' WHERE queue = ? AND key = ?",
            ).run(queue, key);
          }),
        put: (key, value) =>
          Effect.sync(() => {
            db.query(
              "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            ).run(key, JSON.stringify(value ?? null));
          }),
        get: (key) =>
          Effect.sync(() => {
            const row = db
              .query("SELECT value FROM meta WHERE key = ?")
              .get(key) as { value: string } | null;
            return row === null ? undefined : JSON.parse(row.value);
          }),
      });
    }),
  );

// ─── D1: Cloudflare (the deployable shape) ─────────────────────────

/**
 * D1 physics — the implementation OWNS its infrastructure: the
 * `org-ledger` D1 database resource is declared inside this Layer (the
 * bindings pattern applied above the resource level); no process Layer
 * ever sees the table.
 *
 * `INSERT OR IGNORE` decides acceptance in the database — never any
 * instance's memory — so a stateless, concurrent Worker fleet and a
 * laptop process run identical drive code.
 *
 * TODO(deploy): the table is ensured lazily on first offer (D1 `exec`
 * from the delivery path). Once this Worker actually deploys, move the
 * DDL to a `Cloudflare.D1.ApplyMigrations` resource next to the
 * Database declaration and delete the lazy ensure.
 */
// (the Layer's requirement channel is inferred: the QueryDatabase
// binding tag plus the Database resource's provisioning context —
// ambient in a Worker's init Effect, the only place this Layer builds)
export const D1Ledger = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.Database("org-ledger");
    const db = yield* Cloudflare.D1.QueryDatabase(database);

    // The D1 client's executors are colored with RuntimeContext ("runs
    // only inside the deployed Worker"). The Ledger contract is
    // environment-agnostic, and this Layer is the one place that KNOWS
    // its calls run inside the Worker's delivery handlers — so the
    // color is discharged here (the color is phantom: nothing reads
    // the service; see PreparedStatement.withRuntime).
    const inWorker = <A, E>(
      effect: Effect.Effect<A, E, RuntimeContext>,
    ): Effect.Effect<A, E> => Effect.provide(effect, RuntimeContext.phantom);

    const ensured = yield* Effect.cached(
      inWorker(
        Effect.asVoid(
          db.exec(LEDGER_TABLE.trim().replaceAll(/\s+/g, " ")),
        ).pipe(
          Effect.andThen(
            Effect.asVoid(db.exec(META_TABLE.trim().replaceAll(/\s+/g, " "))),
          ),
        ),
      ),
    );

    return Ledger.of({
      offer: (queue, key, task) =>
        Effect.gen(function* () {
          yield* ensured;
          const result = yield* inWorker(
            db
              .prepare(
                "INSERT OR IGNORE INTO ledger (queue, key, task) VALUES (?, ?, ?)",
              )
              .bind(queue, key, JSON.stringify(task ?? null))
              .run(),
          );
          return {
            status:
              result.meta.changes > 0
                ? ("accepted" as const)
                : ("duplicate" as const),
          };
        }),
      settle: (queue, key) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* inWorker(
            db
              .prepare(
                "UPDATE ledger SET status = 'settled' WHERE queue = ? AND key = ?",
              )
              .bind(queue, key)
              .run(),
          );
        }),
      put: (key, value) =>
        Effect.gen(function* () {
          yield* ensured;
          yield* inWorker(
            db
              .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
              .bind(key, JSON.stringify(value ?? null))
              .run(),
          );
        }),
      get: (key) =>
        Effect.gen(function* () {
          yield* ensured;
          const rows = yield* inWorker(
            db
              .prepare("SELECT value FROM meta WHERE key = ?")
              .bind(key)
              .all<{ value: string }>(),
          );
          const row = rows.results[0];
          return row === undefined ? undefined : JSON.parse(row.value);
        }),
    });
  }),
);
