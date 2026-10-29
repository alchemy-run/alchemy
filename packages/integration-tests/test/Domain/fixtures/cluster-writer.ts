/**
 * A process that hosts the contract model on a SQLite file and sends
 * commands until it is killed: `bun cluster-writer.ts <file>`. It arms a
 * timer, prints `ready`, then sends to four counters from eight fibers.
 */
import * as Domain from "@alchemy.run/domain";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Contract, Counter, ExpireHold, Handlers, Hold, Increment } from "./ContractModel.ts";

const file = process.argv[2]!;

const Host = Contract.layer(Handlers).pipe(
  Layer.provide(Domain.Cluster.layerSingleRunner({ runnerStorage: "memory" })),
  Layer.provide(SqliteClient.layer({ filename: file })),
);

Effect.gen(function* () {
  const counters = yield* Counter;
  const holds = yield* Hold;
  yield* holds.schedule("h-1", new ExpireHold(), { after: "1500 millis", commandId: "expire" });
  yield* Console.log("ready");
  yield* Effect.forEach(
    Array.from({ length: 100_000 }, (_, i) => i),
    (i) => counters.send(`c-${i % 4}`, new Increment({ by: 1 }), { commandId: `cmd-${i}` }),
    { concurrency: 8, discard: true },
  );
}).pipe(Effect.provide(Host), BunRuntime.runMain);
