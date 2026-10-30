import { makePostgresState } from "@alchemy.run/sql/PostgresState";
import { describe, expect, it } from "@alchemy.run/test";
import * as PgClient from "@effect/sql-pg/PgClient";
import { readOnlyState, StateStoreError, type StateService } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

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
  url = liveUrl!,
): Effect.Effect<A, E | StateStoreError> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const store = yield* makePostgresState({ url: Redacted.make(url) }, scope);
    return yield* use(store);
  }).pipe(Effect.scoped);

const stack = "alchemy-postgres-state-live";
const request = { stack, stage: "test", fqn: `${stack}/test/db` };

/**
 * A role that can only `select` from the store's tables, as a plan or a
 * drift check in CI would connect. Returns its connection URL.
 */
const selectOnlyRole = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  yield* sql`
    do $$ begin
      create role alchemy_state_reader login password 'reader';
    exception when duplicate_object then null;
    end $$
  `;
  yield* sql`grant usage on schema public to alchemy_state_reader`;
  yield* sql`revoke create on schema public from alchemy_state_reader`;
  yield* sql`grant select on alchemy_resource_state, alchemy_stack_output to alchemy_state_reader`;
  const url = new URL(liveUrl!);
  url.username = "alchemy_state_reader";
  url.password = "reader";
  return url.toString();
}).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(liveUrl!) })));

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

  // #2751: `alchemy plan` and `alchemy drift` only read state.
  it.effect("a read-only run reads as a select-only role while a deploy holds the lock", () =>
    withLiveStore((holder) =>
      Effect.gen(function* () {
        yield* holder.deleteStack({ stack });
        yield* holder.set({ ...request, value: sampleState });
        const readerUrl = yield* selectOnlyRole;

        yield* readOnlyState(
          withLiveStore(
            (reader) =>
              Effect.gen(function* () {
                expect(yield* reader.list({ stack, stage: "test" })).toEqual([request.fqn]);
                expect(yield* reader.get(request)).toBeDefined();
                const refused = yield* reader
                  .set({ ...request, value: sampleState })
                  .pipe(Effect.flip);
                expect(refused.message).toContain("read-only");
              }),
            readerUrl,
          ),
        );

        // The deploy still holds its lock and can keep writing.
        yield* holder.set({ ...request, value: sampleState });
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
});
