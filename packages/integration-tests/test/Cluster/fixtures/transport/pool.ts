import { createServer } from "node:http";
/**
 * A one-runner pool and its gateway, as its own process: `pool.ts
 * <gatewayPort> <runnerPort>`. Prints `ready` once the gateway answers.
 * Shards are held in memory: nothing else joins it.
 */
import { gatewayLayer } from "@alchemy.run/effect-cluster/internal/Gateway";
import { NodeClusterHttp, NodeHttpServer } from "@effect/platform-node";
import { RunnerAddress } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AnySlow, SlowLive, TOKEN } from "./slow.ts";

const [gatewayPort, runnerPort] = process.argv.slice(2).map(Number);

const pool = Layer.mergeAll(
  gatewayLayer([AnySlow], TOKEN).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: gatewayPort, host: "127.0.0.1" })),
  ),
  SlowLive,
).pipe(
  Layer.provide(
    NodeClusterHttp.layer({
      transport: "http",
      storage: "local",
      shardingConfig: {
        runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", runnerPort!)),
      },
    }),
  ),
);

Effect.runFork(
  Effect.gen(function* () {
    yield* Layer.build(pool);
    console.log("ready");
    return yield* Effect.never;
  }).pipe(Effect.scoped),
);
