/**
 * A process that hosts the contract model on a SQLite file and sends
 * commands until it is killed: `bun cluster-writer.ts <file>`. It arms a
 * timer, prints `ready`, then sends to four counters from eight fibers.
 *
 * With `saga` (`bun cluster-writer.ts <file> saga`), it starts `Hang`, whose
 * step prints `debited` after its command commits and then never ends.
 */
import * as Domain from "@alchemy.run/domain";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Contract,
  Counter,
  ExpireHold,
  Handlers,
  Hang,
  hang,
  Hold,
  Increment,
} from "./ContractModel.ts";

const [file, mode] = process.argv.slice(2) as [string, string | undefined];

const Host = Contract.layer(Handlers).pipe(
  Layer.provide(Domain.Cluster.layerSingleRunner({ runnerStorage: "memory" })),
  Layer.provide(SqliteClient.layer({ filename: file })),
);

const saga = Effect.gen(function* () {
  hang.value = true;
  const hangs = yield* Hang;
  yield* hangs.start("h-1", { wallet: "w-h" });
  return yield* Effect.never;
});

const burst = Effect.gen(function* () {
  const counters = yield* Counter;
  const holds = yield* Hold;
  yield* holds.schedule("h-1", new ExpireHold(), { after: "1500 millis", commandId: "expire" });
  yield* Console.log("ready");
  yield* Effect.forEach(
    Array.from({ length: 100_000 }, (_, i) => i),
    (i) => counters.send(`c-${i % 4}`, new Increment({ by: 1 }), { commandId: `cmd-${i}` }),
    { concurrency: 8, discard: true },
  );
});

const main: Effect.Effect<
  void,
  unknown,
  Effect.Services<typeof saga> | Effect.Services<typeof burst>
> = mode === "saga" ? saga : burst;

main.pipe(Effect.provide(Host), BunRuntime.runMain);
