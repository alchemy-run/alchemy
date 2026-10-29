import * as Domain from "@alchemy.run/domain";
import { describe, expect, it } from "@alchemy.run/test";
import * as BunServices from "@effect/platform-bun/BunServices";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import {
  ContractApi,
  Counter,
  eventually,
  Hold,
  hosted,
  Increment,
} from "./fixtures/HostContract.ts";

const counters = ["c-0", "c-1", "c-2", "c-3"];

/** Start the writer on `file`, wait until it is busy, then SIGKILL it after `millis`. */
const killWriterAfter = (file: string, millis: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const writer = path.join(import.meta.dirname, "fixtures", "cluster-writer.ts");
    const handle = yield* spawner.spawn(ChildProcess.make("bun", [writer, file]));
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line === "ready"),
      Stream.runHead,
    );
    yield* Effect.sleep(millis);
    yield* handle.kill({ killSignal: "SIGKILL" });
    yield* handle.exitCode.pipe(Effect.ignore);
  }).pipe(Effect.scoped);

/** What the file must hold whatever moment the writer died at. */
const checkFile = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let committed = 0;
  for (const id of counters) {
    const [row] = yield* sql<{
      version: number;
    }>`SELECT version FROM domain_aggregates WHERE name = 'Counter' AND id = ${id}`;
    const version = row ? Number(row.version) : 0;
    const events = yield* sql<{
      seq: number;
    }>`SELECT seq FROM domain_events WHERE name = 'Counter' AND id = ${id} ORDER BY seq`;
    const receipts = yield* sql<{
      result: string;
    }>`SELECT result FROM domain_receipts WHERE name = 'Counter' AND id = ${id}`;
    // One event and one receipt per committed command, gapless: no receipt
    // without its events, and no events without a receipt.
    expect(events.map((event) => Number(event.seq))).toEqual(
      Array.from({ length: version }, (_, i) => i + 1),
    );
    expect(receipts.length).toBe(version);
    const versions = receipts
      .map(
        (receipt) =>
          (JSON.parse(receipt.result) as { receipt: { version: number } }).receipt.version,
      )
      .sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: version }, (_, i) => i + 1));
    committed += version;
  }
  return committed;
});

describe("Domain.Cluster after a SIGKILL", () => {
  for (const millis of [30, 400, 2_000]) {
    it.live(
      `a writer killed ${millis} ms into a burst loses nothing it committed`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "domain-cluster-crash-" });
          const file = path.join(dir, "domain.db");
          yield* killWriterAfter(file, millis);

          const committed = yield* checkFile.pipe(
            Effect.provide(SqliteClient.layer({ filename: file })),
          );
          yield* Effect.log(`killed after ${millis} ms: ${committed} commands committed`);

          // A new process on the file: the same answers, deliveries and the timer resume.
          yield* Effect.gen(function* () {
            const counter = yield* Counter;
            const holds = yield* Hold;
            const api = yield* ContractApi.Client;
            const sql = yield* SqlClient.SqlClient;
            const [stored] = yield* sql<{
              id: string;
              command_id: string;
              result: string;
            }>`SELECT id, command_id, result FROM domain_receipts WHERE name = 'Counter' ORDER BY at LIMIT 1`;
            if (stored) {
              const replay = yield* counter.send(stored.id, new Increment({ by: 1 }), {
                commandId: stored.command_id,
              });
              const receipt = (JSON.parse(stored.result) as { receipt: { version: number } })
                .receipt;
              expect(replay.version).toBe(receipt.version);
            }
            for (const id of counters) {
              const { total } = yield* counter.state(id);
              if (total === 0) continue;
              const view = yield* api.Totals.get(id, {
                atLeast: { stream: `Counter/${id}`, version: total },
              });
              expect(view).toEqual({ total });
              yield* eventually(
                counter.state(`mirror-${id}`).pipe(
                  Effect.filterOrFail(
                    (s) => s.total === total,
                    () => "not yet" as const,
                  ),
                ),
                30,
              );
            }
            yield* eventually(
              holds.state("h-1").pipe(
                Effect.filterOrFail(
                  (s) => s.status === "expired",
                  () => "not yet" as const,
                ),
              ),
            );
            expect((yield* holds.state("h-1")).expiries).toBe(1);
          }).pipe(
            Effect.scoped,
            Effect.provide(
              hosted(
                Domain.Cluster.layerSingleRunner({ runnerStorage: "memory" }).pipe(
                  Layer.provideMerge(SqliteClient.layer({ filename: file })),
                ),
              ),
            ),
          );
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
      { timeout: 90_000 },
    );
  }
});
