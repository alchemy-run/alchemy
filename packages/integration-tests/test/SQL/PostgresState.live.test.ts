import { makePostgresState } from "@alchemy.run/sql/PostgresState";
import { describe, expect, it } from "@alchemy.run/test";
import * as PgClient from "@effect/sql-pg/PgClient";
import { StateStoreError, type StateService } from "alchemy/State/State";
import { StateEncryption, type StateEncryptionService } from "alchemy/State/StateEncryption";
import { STATE_STORE_FORMAT } from "alchemy/State/StoreFormat";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Live counterpart of `PostgresState.test.ts`. The hermetic suite answers the
 * store's fixed SQL from an in-memory fake, so the statements Postgres itself
 * must accept — `hashtextextended` key derivation, `pg_try_advisory_lock`
 * session semantics, the `pg_locks` holder verification, the transactional
 * schema migration — only run for real here.
 *
 * Guarded like the other live suites: set
 * `ALCHEMY_RUN_LIVE_POSTGRES_STATE_TESTS=true` and point
 * `POSTGRES_STATE_TEST_URL` at a scratch Postgres database.
 */
const wantsLive = process.env.ALCHEMY_RUN_LIVE_POSTGRES_STATE_TESTS === "true";
const liveUrl = process.env.POSTGRES_STATE_TEST_URL?.trim();
const runLive = wantsLive && !!liveUrl;

if (wantsLive && !liveUrl) {
  it.effect(
    "requires a database url for the live Postgres state suite",
    () =>
      Effect.fail(
        new Error(
          [
            "Live Postgres state suite requested but no database is configured.",
            "Set POSTGRES_STATE_TEST_URL to a scratch Postgres connection URL,",
            "then rerun with ALCHEMY_RUN_LIVE_POSTGRES_STATE_TESTS=true.",
          ].join(" "),
        ),
      ),
    { tags: ["local"] },
  );
}

/** Each store gets its own pool, as separate deploy processes would. */
const withLiveStore = <A, E>(
  use: (store: StateService) => Effect.Effect<A, E>,
): Effect.Effect<A, E | StateStoreError> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const store = yield* makePostgresState({ url: Redacted.make(liveUrl!) }, scope);
    return yield* use(store);
  }).pipe(Effect.scoped);

const stack = "alchemy-postgres-state-live";
const request = { stack, stage: "test", fqn: `${stack}/test/db` };

const sampleState = {
  kind: "resource",
  status: "created",
  logicalId: "db",
  output: { password: Redacted.make("s3cret") },
} as never;

describe.skipIf(!runLive)("Postgres state store against real Postgres", { tags: ["local"] }, () => {
  it.effect("round-trips resource state through a real database", () =>
    withLiveStore((store) =>
      Effect.gen(function* () {
        // Leftovers from an interrupted earlier run must not fail this one.
        yield* store.deleteStack({ stack });

        expect(yield* store.get(request)).toBeUndefined();

        yield* store.set({ ...request, value: sampleState });
        const revived = (yield* store.get(request)) as {
          output: { password: Redacted.Redacted<string> };
        };
        expect(Redacted.isRedacted(revived.output.password)).toBe(true);
        expect(Redacted.value(revived.output.password)).toBe("s3cret");

        yield* store.delete(request);
        expect(yield* store.get(request)).toBeUndefined();

        yield* store.deleteStack({ stack });
      }),
    ),
  );

  it.effect("refuses a second deploy while the stage advisory lock is held", () =>
    withLiveStore((holder) =>
      Effect.gen(function* () {
        // The first operation acquires the session advisory lock for the
        // (stack, stage) and keeps it for the life of the holder's scope.
        yield* holder.set({ ...request, value: sampleState });

        const error = yield* withLiveStore((contender) => contender.get(request)).pipe(Effect.flip);
        expect(error).toBeInstanceOf(StateStoreError);
        expect(error.message).toContain("holds the Postgres state lock");

        yield* holder.deleteStack({ stack });
      }),
    ),
  );

  it.effect("releases the lock when the store's scope closes", () =>
    Effect.gen(function* () {
      yield* withLiveStore((store) => store.set({ ...request, value: sampleState }));
      // The previous store's scope has closed, so a fresh deploy proceeds.
      yield* withLiveStore((store) =>
        Effect.gen(function* () {
          expect(yield* store.get(request)).toBeDefined();
          yield* store.deleteStack({ stack });
        }),
      );
    }),
  );

  it.effect("migrates the schema concurrently without colliding", () =>
    // Two fresh pools race the first state operation, so both run the
    // transactional `create table if not exists` migration at once — the
    // concurrency that fails on real Postgres without the advisory lock.
    Effect.all(
      [
        withLiveStore((store) => store.deleteStack({ stack: `${stack}-migrate-a` })),
        withLiveStore((store) => store.deleteStack({ stack: `${stack}-migrate-b` })),
      ],
      { concurrency: 2 },
    ),
  );

  it.effect("renames a database's value column, so versions before format records fail on it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The schema an earlier version created, with a row in it.
      yield* sql`drop table if exists alchemy_resource_state, alchemy_stack_output, alchemy_state_store`;
      yield* sql`create table alchemy_resource_state (stack text not null, stage text not null, fqn text not null, value jsonb not null, updated_at timestamptz not null default now(), primary key (stack, stage, fqn))`;
      yield* sql`create table alchemy_stack_output (stack text not null, stage text not null, value jsonb not null, updated_at timestamptz not null default now(), primary key (stack, stage))`;
      yield* sql`insert into alchemy_resource_state (stack, stage, fqn, value) values (${request.stack}, ${request.stage}, ${request.fqn}, ${JSON.stringify({ status: "created", logicalId: "db" })}::jsonb)`;

      yield* withLiveStore((store) =>
        Effect.gen(function* () {
          expect(yield* store.get(request)).toMatchObject({ status: "created" });
          yield* store.deleteStack({ stack });
        }),
      );

      const [format] = yield* sql`select format from alchemy_state_store`;
      expect(Number(format!.format)).toBe(STATE_STORE_FORMAT);
      // What an earlier version runs to read a record now fails.
      const old = yield* sql`select value from alchemy_resource_state`.pipe(Effect.flip);
      expect(Cause.pretty(Cause.fail(old))).toContain('column "value" does not exist');
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(liveUrl ?? "") }))),
  );

  it.effect("keeps a StateEncryption's ciphertext in the row, readable by status", () =>
    withLiveStore((store) =>
      Effect.gen(function* () {
        yield* store.deleteStack({ stack });
        yield* store.set({
          ...request,
          value: { ...(sampleState as object), status: "replaced" } as never,
        });
        const replaced = (yield* store.getReplacedResources(request)) as unknown as ReadonlyArray<{
          output: { password: Redacted.Redacted<string> };
        }>;
        expect(replaced.length).toBe(1);
        expect(Redacted.value(replaced[0]!.output.password)).toBe("s3cret");
        yield* store.deleteStack({ stack });
      }),
    ).pipe(Effect.provide(Layer.succeed(StateEncryption, testEncryption))),
  );
});

/** A fixed-key StateEncryption, enough to exercise the store's use of it. */
const fixedKey = new Uint8Array(32).fill(7);
const testEncryption: StateEncryptionService = {
  id: "test",
  generate: () => Effect.succeed({ plaintext: fixedKey, wrapped: "Zml4ZWQ=" }),
  unwrap: () => Effect.succeed(fixedKey),
};
