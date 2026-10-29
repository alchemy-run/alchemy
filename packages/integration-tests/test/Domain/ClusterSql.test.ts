/**
 * The cluster host on SQL servers. Each suite runs only when its database
 * URL is set:
 *
 *   DOMAIN_TEST_POSTGRES_URL=postgres://user@localhost/domain_cluster_test
 *   DOMAIN_TEST_MYSQL_URL=mysql://user@localhost/domain_cluster_test
 *
 * Every test uses its own table prefixes, and drops its tables before and
 * after it runs.
 */
import { describe, expect, it } from "@alchemy.run/test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import {
  clean,
  migrate,
  singleRunner,
  socketRunner,
  sqlClient,
  type SqlLayer,
} from "./fixtures/ClusterRunners.ts";
import {
  ContractApi,
  Counter,
  eventually,
  hostContract,
  hosted,
  Increment,
} from "./fixtures/HostContract.ts";

const POSTGRES_URL = process.env.DOMAIN_TEST_POSTGRES_URL;
const MYSQL_URL = process.env.DOMAIN_TEST_MYSQL_URL;

const suite = (
  name: string,
  url: string | undefined,
  client: (url: string) => SqlLayer,
  ports: readonly [number, number, number, number],
) =>
  describe.skipIf(url === undefined)(`Domain.Cluster on ${name}`, () => {
    const tag = name.toLowerCase();
    let next = 0;
    // MySQL and MariaDB: a deadlock must not leave a stored reply without the
    // writes it reports (https://github.com/Effect-TS/effect/issues/10162).
    const stress = `dct_${tag}_stress`;
    /** A host on new tables, with one runner and its own connection pool. */
    const onPrefix = (prefix: string) =>
      singleRunner(prefix).pipe(Layer.provide(clean(prefix)), Layer.provideMerge(client(url!)));

    hostContract(`Cluster on ${name}`, () => onPrefix(`dct_${tag}_${next++}`));

    it.live(
      "concurrent commands keep one event and one receipt each; every processed view delivery is applied",
      () =>
        Effect.gen(function* () {
          const prefix = stress;
          const counters = yield* Counter;
          const api = yield* ContractApi.Client;
          const sql = yield* SqlClient.SqlClient;
          const ids = ["s-1", "s-2", "s-3", "s-4"];
          // 16 fibers, 160 commands, 4 instances: each command commits an
          // event, a receipt and outbox rows while views, the policy and the
          // projection write their own rows and the cluster's.
          yield* Effect.forEach(
            Array.from({ length: 160 }, (_, i) => i),
            (i) => counters.send(ids[i % 4]!, new Increment({ by: 1 }), { commandId: `cmd-${i}` }),
            { concurrency: 16, discard: true },
          );
          for (const id of ids) {
            expect(yield* counters.state(id)).toEqual({ total: 40 });
            yield* api.Totals.get(id, { atLeast: { stream: `Counter/${id}`, version: 40 } });
            yield* eventually(
              counters.state(`mirror-${id}`).pipe(
                Effect.filterOrFail(
                  (s) => s.total === 40,
                  () => "not yet" as const,
                ),
              ),
              30,
            );
          }
          for (const id of ids) {
            const [row] = yield* sql<{
              version: number;
            }>`SELECT version FROM ${sql(`${prefix}_aggregates`)} WHERE name = 'Counter' AND id = ${id}`;
            const events = yield* sql<{
              seq: number;
            }>`SELECT seq FROM ${sql(`${prefix}_events`)} WHERE name = 'Counter' AND id = ${id} ORDER BY seq`;
            const receipts = yield* sql<{
              n: number;
            }>`SELECT COUNT(*) AS n FROM ${sql(`${prefix}_receipts`)} WHERE name = 'Counter' AND id = ${id}`;
            // Every receipt has its events and its state: gapless, one per command.
            expect(Number(row!.version)).toBe(40);
            expect(events.map((event) => Number(event.seq))).toEqual(
              Array.from({ length: 40 }, (_, i) => i + 1),
            );
            expect(Number(receipts[0]!.n)).toBe(40);
          }
          // Each view delivery the cluster marked processed (its reply is
          // stored): the key's checkpoint for its source has reached its seq.
          // A checkpoint alone cannot show that no earlier seq was skipped;
          // the exact view totals above do. This load does not force the
          // deadlock of #10162; it checks the result under real contention.
          const processed = yield* sql<{
            entity_id: string;
            payload: string;
          }>`SELECT entity_id, payload FROM ${sql(`${prefix}c_messages`)} WHERE entity_type = ${`Domain.View/${prefix}/Totals`} AND processed = ${sql.literal(tag === "postgres" ? "TRUE" : "1")}`;
          expect(processed.length).toBeGreaterThan(0);
          for (const message of processed) {
            const { delivery } = JSON.parse(message.payload) as {
              delivery: { source: string; seq: number };
            };
            const [view] = yield* sql<{
              snapshot: string;
            }>`SELECT snapshot FROM ${sql(`${prefix}_views`)} WHERE name = 'Totals' AND id = ${message.entity_id}`;
            const snapshot = JSON.parse(view!.snapshot) as { checkpoints: Record<string, number> };
            expect(snapshot.checkpoints[delivery.source]!).toBeGreaterThanOrEqual(delivery.seq);
          }
        }).pipe(Effect.scoped, Effect.provide(hosted(onPrefix(stress)))),
      { timeout: 120_000 },
    );

    it.live(
      "two runners share one database; a live read on one follows commits on the other; one stops and the other takes over its work",
      () =>
        Effect.gen(function* () {
          const prefix = `dct_${tag}_runners`;
          yield* Layer.build(
            migrate(prefix).pipe(Layer.provide(clean(prefix)), Layer.provide(client(url!))),
          );
          const start = (port: number) =>
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              // Stopped before the tables are dropped, even when the test fails.
              yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
              const context = yield* Layer.buildWithScope(
                hosted(socketRunner(prefix, port).pipe(Layer.provideMerge(client(url!)))),
                scope,
              );
              return { scope, context };
            });
          const a = yield* start(ports[0]);
          const b = yield* start(ports[1]);
          const ids = Array.from({ length: 20 }, (_, i) => `r-${i}`);
          const sendAll = (runner: typeof a, round: number) =>
            Effect.forEach(
              ids,
              (id) =>
                Effect.gen(function* () {
                  const counters = yield* Counter;
                  yield* counters.send(id, new Increment({ by: 1 }), {
                    commandId: `${id}-${round}`,
                  });
                }).pipe(Effect.provide(runner.context)),
              { concurrency: "unbounded", discard: true },
            );

          // Both runners answer for every instance, wherever its shard is.
          yield* sendAll(a, 1);
          // Live reads on A; about half the instances commit on B.
          const watches = yield* Effect.forEach(ids, (id) =>
            Effect.gen(function* () {
              const api = yield* ContractApi.Client;
              return yield* api.Counter.watch(id).pipe(
                Stream.take(2),
                Stream.runCollect,
                Effect.forkChild,
              );
            }).pipe(Effect.provide(a.context)),
          );
          yield* Effect.sleep("300 millis");
          yield* sendAll(b, 2);
          for (const watch of watches) {
            const [first, second] = yield* Fiber.join(watch).pipe(Effect.timeout("10 seconds"));
            expect([first!.cursor, second!.cursor]).toEqual([1, 2]);
          }

          // B stops; A takes its shards and its work.
          const stopping = yield* Effect.sync(() => Date.now());
          yield* Scope.close(b.scope, Exit.void);
          const stopped = yield* Effect.sync(() => Date.now());
          yield* sendAll(a, 3);
          const answered = yield* Effect.sync(() => Date.now());
          yield* Effect.log(
            `Domain.Cluster on ${name}: runner stop ${stopped - stopping} ms, then 20 commands answered in ${answered - stopped} ms`,
          );
          yield* Effect.gen(function* () {
            const counters = yield* Counter;
            const api = yield* ContractApi.Client;
            for (const id of ids) {
              expect(yield* counters.state(id)).toEqual({ total: 3 });
              yield* eventually(
                api.Totals.get(id).pipe(
                  Effect.filterOrFail(
                    (view) => view?.total === 3,
                    () => "not yet" as const,
                  ),
                ),
                60,
              );
            }
          }).pipe(Effect.provide(a.context));
        }).pipe(Effect.scoped),
      { timeout: 120_000 },
    );

    it.live(
      "a runner killed with SIGKILL: the other takes its shards and finishes its work",
      () =>
        Effect.gen(function* () {
          const prefix = `dct_${tag}_kill`;
          yield* Layer.build(
            migrate(prefix).pipe(Layer.provide(clean(prefix)), Layer.provide(client(url!))),
          );
          const a = yield* Layer.build(
            hosted(socketRunner(prefix, ports[2]).pipe(Layer.provideMerge(client(url!)))),
          );
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const path = yield* Path.Path;
          const runner = path.join(import.meta.dirname, "fixtures", "cluster-runner.ts");
          const b = yield* spawner.spawn(
            ChildProcess.make("bun", [runner, url!, prefix, String(ports[3])]),
          );
          yield* b.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line === "ready"),
            Stream.runHead,
          );
          // Let the shards spread over both runners.
          yield* Effect.sleep("3 seconds");
          const ids = Array.from({ length: 20 }, (_, i) => `k-${i}`);
          const sendAll = (round: number) =>
            Effect.forEach(
              ids,
              (id) =>
                Effect.gen(function* () {
                  const counters = yield* Counter;
                  yield* counters.send(id, new Increment({ by: 1 }), {
                    commandId: `${id}-${round}`,
                  });
                }).pipe(Effect.provide(a)),
              { concurrency: "unbounded", discard: true },
            );
          yield* sendAll(1);
          yield* b.kill({ killSignal: "SIGKILL" });
          yield* b.exitCode.pipe(Effect.ignore);
          const killed = yield* Effect.sync(() => Date.now());
          yield* sendAll(2);
          const answered = yield* Effect.sync(() => Date.now());
          yield* Effect.log(
            `Domain.Cluster on ${name}: runner SIGKILL, then 20 commands answered in ${answered - killed} ms`,
          );
          yield* Effect.gen(function* () {
            const counters = yield* Counter;
            const api = yield* ContractApi.Client;
            for (const id of ids) {
              expect(yield* counters.state(id)).toEqual({ total: 2 });
              yield* eventually(
                api.Totals.get(id).pipe(
                  Effect.filterOrFail(
                    (view) => view?.total === 2,
                    () => "not yet" as const,
                  ),
                ),
                60,
              );
              yield* eventually(
                counters.state(`mirror-${id}`).pipe(
                  Effect.filterOrFail(
                    (s) => s.total === 2,
                    () => "not yet" as const,
                  ),
                ),
                60,
              );
            }
          }).pipe(Effect.provide(a));
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
      { timeout: 180_000 },
    );
  });

suite("Postgres", POSTGRES_URL, sqlClient, [34431, 34432, 34435, 34436]);
suite("MySQL", MYSQL_URL, sqlClient, [34433, 34434, 34437, 34438]);
