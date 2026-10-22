import * as Domain from "@alchemy.run/domain";
import { Bank, BankHandlers } from "@bank/domain/Bank.model";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { MemoryLedgerStore } from "@bank/domain/Ledger/LedgerStore";
import { sessionClient } from "@bank/domain/Session.middleware";
import { NodeFileSystem } from "@effect/platform-node";
import { LibsqlClient } from "@effect/sql-libsql";
import { MysqlClient } from "@effect/sql-mysql2";
import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { SiftFraudCheck } from "../src/Fraud/SiftFraudCheck.ts";
import { MfaChallengeLive } from "../src/MfaChallenge.ts";
import { SessionLive } from "../src/Session.ts";
import { StripePayments } from "../src/Settlement/StripePayments.ts";
import { register, transfer } from "./flows.ts";

/** One host of the bank: what one server process runs, on the SQL database `sql`. */
const host = (sql: Layer.Layer<SqlClient.SqlClient>) =>
  Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(
    Layer.provideMerge(
      Bank.layer(BankHandlers).pipe(
        Layer.provide(
          Layer.mergeAll(
            SiftFraudCheck,
            StripePayments,
            MemoryLedgerStore,
            Domain.StoragePlatform.pipe(
              Layer.provide(Domain.SqlStorage),
              Layer.provide(sql),
              Layer.orDie,
            ),
          ),
        ),
      ),
    ),
  );

const asCustomer = (id: string) =>
  CustomerApi.testClient.pipe(Effect.provide(sessionClient(`customer:${id}`)));

/** Run `effect` on a host of the bank, then stop the host. */
const onHost = <A, E>(
  sql: Layer.Layer<SqlClient.SqlClient>,
  effect: Effect.Effect<A, E, Scope.Scope | Layer.Success<ReturnType<typeof host>>>,
) => effect.pipe(Effect.scoped, Effect.provide(host(sql)));

/** A SQLite database in a fresh file. */
const sqliteFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "domain-storage-" });
  return `file:${dir}/bank.db`;
}).pipe(Effect.provide(NodeFileSystem.layer));

describe("on a SQLite file", () => {
  it.live("the bank survives a restart", () =>
    Effect.gen(function* () {
      const url = yield* sqliteFile;
      const database = LibsqlClient.layer({ url }).pipe(Layer.orDie);
      const accountId = yield* onHost(
        database,
        Effect.gen(function* () {
          const sam = yield* asCustomer("c-1");
          const accountId = yield* register(sam, "c-1", "sam");
          yield* sam.DepositMoney({ target: accountId, amount: 120 });
          return accountId;
        }),
      );
      // A new process on the same database: the account and its views are there.
      yield* onHost(
        database,
        Effect.gen(function* () {
          const sam = yield* asCustomer("c-1");
          const { reply } = yield* sam.DepositMoney({ target: accountId, amount: 5 });
          expect(reply.balance).toBe(125);
          const events = yield* sam.Account.events(accountId).pipe(
            Stream.take(3),
            Stream.runCollect,
          );
          expect(events.map((e) => e.event._tag)).toEqual([
            "AccountOpened",
            "MoneyDeposited",
            "MoneyDeposited",
          ]);
          const summary = yield* sam.AccountSummary.watch(accountId).pipe(
            Stream.filter((s) => s?.balance === 125),
            Stream.runHead,
            Effect.timeout("10 seconds"),
          );
          expect(summary._tag).toBe("Some");
        }),
      );
    }).pipe(Effect.scoped),
  );
});

/**
 * The cases a database server adds: several hosts at once, and hosts that stop.
 * Each runs when its URL is set, e.g. against a local container.
 */
const onServer = (
  name: string,
  url: string | undefined,
  client: (url: string) => Layer.Layer<SqlClient.SqlClient>,
) =>
  describe.skipIf(!url)(`on ${name}`, () => {
    const database = client(url ?? "");
    const query = <A extends object>(statement: string) =>
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(statement)).pipe(
        Effect.provide(database),
        Effect.orDie,
      );
    /** Fresh tables, so every test starts from an empty bank. */
    const reset = Effect.forEach(
      ["domain_kv", "domain_partition", "domain_timer"],
      (table) => query(`DROP TABLE IF EXISTS ${table}`),
      { discard: true },
    );

    it.live(
      "two hosts serve one bank: commands on either, each applied once",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const a = yield* Layer.build(host(database));
          const b = yield* Layer.build(host(database));
          const samOnA = yield* asCustomer("c-1").pipe(Effect.provide(a));
          const samOnB = yield* asCustomer("c-1").pipe(Effect.provide(b));
          const alex = yield* asCustomer("c-2").pipe(Effect.provide(b));

          const from = yield* register(samOnA, "c-1", "sam");
          const to = yield* register(alex, "c-2", "alex");
          // Twenty deposits to one account, from both hosts at once.
          const receipts = yield* Effect.forEach(
            Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? samOnA : samOnB)),
            (sam) => sam.DepositMoney({ target: from, amount: 5 }),
            { concurrency: "unbounded" },
          );
          expect(new Set(receipts.map((r) => r.version)).size).toBe(20);
          expect(Math.max(...receipts.map((r) => r.reply.balance))).toBe(100);

          const outcome = yield* transfer(samOnA, { transferId: "t-1", from, to, amount: 30 });
          expect(outcome.status).toBe("completed");
          const dashboard = yield* alex.CustomerDashboard.watch(CustomerId.make("c-2")).pipe(
            Stream.filter((d) => d !== null && d.balances[to] === 30),
            Stream.runHead,
            Effect.timeout("20 seconds"),
          );
          expect(dashboard._tag).toBe("Some");
          // Views catch up just after: host B sees host A's commits on its next poll.
          const summary = yield* samOnB.AccountSummary.watch(from).pipe(
            Stream.filter((s) => s?.balance === 70),
            Stream.runHead,
            Effect.timeout("10 seconds"),
          );
          expect(summary._tag).toBe("Some");
        }).pipe(Effect.scoped),
      { timeout: 60_000 },
    );

    it.live(
      "a host that stops before delivering leaves its deliveries to another",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const accountId = yield* onHost(
            database,
            Effect.gen(function* () {
              const sam = yield* asCustomer("c-1");
              const accountId = yield* register(sam, "c-1", "sam");
              // Committed, then the host stops before its deliveries run.
              yield* sam.DepositMoney({ target: accountId, amount: 80 });
              return accountId;
            }),
          );
          const pending = yield* query<{ n: string }>(
            "SELECT count(*) AS n FROM domain_timer WHERE name = 'outbox'",
          );
          expect(Number(pending[0]!.n)).toBeGreaterThan(0);
          // Another host picks the work up from its timer, and finishes it.
          yield* onHost(
            database,
            Effect.gen(function* () {
              const sam = yield* asCustomer("c-1");
              const summary = yield* sam.AccountSummary.watch(accountId).pipe(
                Stream.filter((s) => s?.balance === 80),
                Stream.runHead,
                Effect.timeout("30 seconds"),
              );
              expect(summary._tag).toBe("Some");
              yield* query<{ n: string }>("SELECT count(*) AS n FROM domain_timer").pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("200 millis"),
                  until: (rows) => Number(rows[0]!.n) === 0,
                  times: 50,
                }),
              );
            }),
          );
          const left = yield* query<{ n: string }>("SELECT count(*) AS n FROM domain_timer");
          expect(Number(left[0]!.n)).toBe(0);
        }),
      { timeout: 60_000 },
    );

    it.live(
      "work held by a host that crashed runs once its lease lapses",
      () =>
        Effect.gen(function* () {
          yield* reset;
          const accountId = yield* onHost(
            database,
            Effect.flatMap(asCustomer("c-1"), (sam) => register(sam, "c-1", "sam")),
          );
          // A host that died mid-delivery: its lease on the account's outbox stays for 2 seconds.
          yield* Effect.gen(function* () {
            const storage = yield* Domain.Storage;
            yield* storage.transact(`aggregate/Account/${accountId}`, (tx) =>
              tx.put({ "outbox-lease": { token: "crashed", until: Date.now() + 2_000 } }),
            );
          }).pipe(Effect.provide(Domain.SqlStorage.pipe(Layer.provide(database))), Effect.orDie);
          yield* onHost(
            database,
            Effect.gen(function* () {
              const sam = yield* asCustomer("c-1");
              yield* sam.DepositMoney({ target: accountId, amount: 50 });
              const summary = yield* sam.AccountSummary.watch(accountId).pipe(
                Stream.filter((s) => s?.balance === 50),
                Stream.runHead,
                Effect.timeout("10 seconds"),
              );
              expect(summary._tag).toBe("Some");
            }),
          );
        }),
      { timeout: 60_000 },
    );
  });

onServer("Postgres", process.env.DOMAIN_TEST_POSTGRES_URL, (url) =>
  PgClient.layer({ url: Redacted.make(url) }).pipe(Layer.orDie),
);
onServer("MySQL", process.env.DOMAIN_TEST_MYSQL_URL, (url) =>
  MysqlClient.layer({ url: Redacted.make(url) }).pipe(Layer.orDie),
);
