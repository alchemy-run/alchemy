/**
 * A socket runner in its own process, for a test that kills it:
 * `bun cluster-runner.ts <database url> <table prefix> <port>`. It hosts the
 * contract model on the shared database, prints `ready`, and runs until it
 * is killed.
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { socketRunner, sqlClient } from "./ClusterRunners.ts";
import { Contract, Handlers } from "./ContractModel.ts";

const [url, prefix, port] = process.argv.slice(2) as [string, string, string];

const Runner = Contract.layer(Handlers).pipe(
  Layer.provide(socketRunner(prefix, Number(port))),
  Layer.provide(sqlClient(url)),
);

Effect.gen(function* () {
  yield* Console.log("ready");
  return yield* Effect.never;
}).pipe(Effect.provide(Runner), BunRuntime.runMain);
