/**
 * The replica entity's implementation. In a runner on Railway it also
 * listens on the private network for `POST /crash`, and exits that runner's
 * process at once: no finalizers, no shard release, no unregistering. Only
 * the suite's front calls it, at one replica's own address. A crash a test
 * asks for, rather than a platform API, because Railway has none that stops
 * one replica of a Service.
 */
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import type * as Cluster from "@alchemy.run/effect-cluster";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { Replicas } from "./replica.ts";

/** The private port runners listen for a crash on, beside the cluster's own. */
export const CRASH_PORT = 34999;

/** This process's own private IPv6 addresses. */
const ownAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .flatMap((iface) =>
      iface !== undefined &&
      !iface.internal &&
      iface.family === "IPv6" &&
      !iface.address.startsWith("fe80:")
        ? [iface.address]
        : [],
    );

/** Listen for `POST /crash` for the process's lifetime: only in a runner on Railway. */
const crashListener = Effect.gen(function* () {
  const replica = yield* Config.option(Config.String("RAILWAY_REPLICA_ID"));
  if (!globalThis.__ALCHEMY_RUNTIME__ || Option.isNone(replica)) return;
  yield* Effect.sync(() =>
    createServer((request, response) => {
      if (request.method === "POST" && request.url === "/crash") {
        response.end("crashing\n", () => process.exit(137));
        return;
      }
      response.statusCode = 404;
      response.end();
    }).listen(CRASH_PORT, "::"),
  );
});

export const replicaLive = <R>(main: string, pool: Cluster.PoolLayer<R>) =>
  Replicas.make(
    { main },
    Effect.gen(function* () {
      yield* crashListener;
      return Effect.gen(function* () {
        const balance = yield* Ref.make(0);
        return Replicas.of({
          Where: () =>
            Effect.gen(function* () {
              return {
                service: yield* Config.String("RAILWAY_SERVICE_ID"),
                replica: yield* Config.String("RAILWAY_REPLICA_ID"),
                addresses: ownAddresses(),
              };
            }).pipe(Effect.orDie),
          Credit: ({ payload }) => Ref.updateAndGet(balance, (n) => n + payload.amount),
        });
      });
    }).pipe(Effect.provide(pool)),
  );
