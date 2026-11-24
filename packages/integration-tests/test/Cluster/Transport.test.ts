import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
/**
 * How calls reach a pool when the process at the other end restarts or goes
 * away, on real local processes and sockets: a one-runner pool and its
 * gateway run as a child process, reached directly or through a relay that
 * the test cuts.
 */
import { makeNamespace } from "@alchemy.run/effect-cluster/internal/Gateway";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { freePort, relayTo } from "./fixtures/relay.ts";
import { AnySlow, TOKEN } from "./fixtures/transport/slow.ts";

const poolProgram = fileURLToPath(new URL("./fixtures/transport/pool.ts", import.meta.url));

/** Run a pool serving its gateway on `gatewayPort`, killed with the test's scope. */
const runPool = (gatewayPort: number) =>
  Effect.gen(function* () {
    const runnerPort = yield* freePort;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [poolProgram, String(gatewayPort), String(runnerPort)], {
          stdio: "ignore",
        }),
      ),
      (child) => Effect.sync(() => child.kill("SIGKILL")),
    );
  });

interface SlowClient {
  readonly Call: (payload: { id: string; ms: number }) => Effect.Effect<number, unknown>;
  readonly Runs: (payload: { id: string }) => Effect.Effect<number, unknown>;
}

/** A caller outside the cluster, reaching the gateway at `port`. */
const slowAt = (port: number, id: string) =>
  makeNamespace(AnySlow, { url: `http://127.0.0.1:${port}`, token: TOKEN })
    .getByName(id)
    .pipe(Effect.map((client) => client as unknown as SlowClient));

const call = (port: number, id: string, ms: number) =>
  Effect.flatMap(slowAt(port, id), (slow) => slow.Call({ id, ms }));

/** How many times `id` has run, asked of another instance: `id`'s own is busy running it. */
const runsOf = (port: number, id: string) =>
  Effect.flatMap(slowAt(port, `count-${id}`), (slow) => slow.Runs({ id }));

/** Start a pool and wait until it answers calls. */
const started = Effect.gen(function* () {
  const gatewayPort = yield* freePort;
  yield* runPool(gatewayPort);
  yield* runsOf(gatewayPort, "warm").pipe(
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
  );
  return gatewayPort;
});

describe("Cluster calls through a gateway", { tags: ["provider:cluster", "unit", "local"] }, () => {
  it.live(
    "a call sent before its gateway listens is sent again once it does, and runs once",
    () =>
      Effect.gen(function* () {
        const gatewayPort = yield* freePort;
        // Nothing listens yet: the call's connection is refused, as while a
        // runner restarts. The pool starts half a second later.
        yield* runPool(gatewayPort).pipe(Effect.delay("500 millis"), Effect.forkScoped);
        expect(yield* call(gatewayPort, "before-listen", 0)).toEqual(1);
        expect(yield* runsOf(gatewayPort, "before-listen")).toEqual(1);
      }),
    { timeout: 30_000 },
  );

  it.live(
    "a call that reached its gateway is never sent again, even when its connection is cut",
    () =>
      Effect.gen(function* () {
        const gatewayPort = yield* started;
        const relay = yield* relayTo(gatewayPort);
        const sent = yield* call(relay.port, "cut", 2_000).pipe(Effect.exit, Effect.forkScoped);
        // The handler is running: the call reached the gateway.
        yield* runsOf(gatewayPort, "cut").pipe(
          Effect.repeat({ until: (runs) => runs === 1, schedule: Schedule.spaced("20 millis") }),
        );
        expect(yield* relay.cut).toBeGreaterThan(0);
        expect(Exit.isFailure(yield* Fiber.join(sent))).toBe(true);
        // A caller that sent it again would have run it again by now.
        yield* Effect.sleep("3 seconds");
        expect(yield* runsOf(gatewayPort, "cut")).toEqual(1);
      }),
    { timeout: 30_000 },
  );

  it.live(
    "a slow call to a gateway that is up is waited for, and runs once",
    () =>
      Effect.gen(function* () {
        const gatewayPort = yield* started;
        expect(yield* call(gatewayPort, "slow", 4_000)).toEqual(1);
        expect(yield* runsOf(gatewayPort, "slow")).toEqual(1);
      }),
    { timeout: 30_000 },
  );
});
