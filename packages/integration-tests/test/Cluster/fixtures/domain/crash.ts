import * as NodeChildProcess from "node:child_process";
/**
 * Crash cases for the Domain host on Effect Cluster: one of the pool's two
 * runners is killed with SIGKILL while it works, and the cases check what
 * the other runner (and the one Swarm starts again) makes of it.
 */
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

type TestFn = (
  name: string,
  effect: Effect.Effect<void, any, any>,
  options?: { readonly timeout?: number; readonly exclusive?: boolean },
) => void;

export interface CrashOptions {
  readonly test: TestFn;
  readonly url: string;
  /** The deployed stack and stage: the runners are the Swarm tasks of its pool service. */
  readonly stack: { readonly name: string; readonly stage: string };
}

const docker = (args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

/** The pool's Swarm service. */
const poolService = (stack: CrashOptions["stack"]) =>
  docker([
    "service",
    "ls",
    "--filter",
    "label=alchemy::id=DomainPoolPool",
    "--filter",
    `label=alchemy::stack=${stack.name}`,
    "--filter",
    `label=alchemy::stage=${stack.stage}`,
    "--format",
    "{{.Name}}",
  ]);

/** The running containers of the pool: one per runner. */
const runners = (stack: CrashOptions["stack"]) => {
  const service = poolService(stack);
  const ids = docker([
    "ps",
    "--filter",
    `label=com.docker.swarm.service.name=${service}`,
    "--format",
    "{{.ID}}",
  ]);
  return ids === "" ? [] : ids.split("\n");
};

/** SIGKILL one runner: no shutdown, no shard handoff. Swarm starts a new task in its place. */
const killOne = (stack: CrashOptions["stack"]) =>
  Effect.sync(() => {
    const [victim] = runners(stack);
    if (victim === undefined) throw new Error("the pool has no running runner");
    docker(["kill", "--signal", "KILL", victim]);
    return victim;
  });

/** Wait until the pool runs two runners again, neither of them `killed`. */
const bothRunning = (stack: CrashOptions["stack"], killed: string) =>
  Effect.sync(() => runners(stack)).pipe(
    Effect.filterOrFail(
      (running) => running.length === 2 && !running.includes(killed),
      () => "not yet" as const,
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );

const fresh = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

const get = <T>(base: string, path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${base}${path}`);
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`${path} answered ${response.status}: ${yield* response.text}`),
      );
    }
    return (yield* response.json) as T;
  }).pipe(Effect.timeout("30 seconds"));

/** How long a case waits for the cluster to recover: the dead runner's shards move on. */
const RECOVERY = 180_000;

export const crash = ({ test, url, stack }: CrashOptions) => {
  const call = <T>(path: string) => get<T>(url, path);
  /** Call until it answers, while the cluster recovers. */
  const untilAnswered = <T>(path: string) =>
    call<T>(path).pipe(
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: RECOVERY / 1_000 }),
    );
  const eventually = <T>(path: string, until: (value: T) => boolean) =>
    untilAnswered<T>(path).pipe(
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until, times: RECOVERY / 1_000 }),
    );
  // Alone: a kill would fail any other case's calls.
  const options = { timeout: 600_000, exclusive: true };

  test(
    "a runner killed during a burst loses no accepted command, and counts each once",
    Effect.gen(function* () {
      const counters = Array.from({ length: 8 }, (_, i) => fresh(`burst${i}`));
      const commands = Array.from({ length: 160 }, (_, n) => ({
        id: counters[n % counters.length]!,
        command: fresh(`cmd${n}`),
      }));
      const send = ({ id, command }: (typeof commands)[number]) =>
        call<{ accepted: number }>(`/increment/${id}?by=1&command=${command}`);
      // Every counter exists before the kill, so its saga run starts first.
      yield* Effect.forEach(commands.slice(0, counters.length), send, { discard: true });
      const rest = commands.slice(counters.length);
      const outcomes = yield* Effect.all(
        [
          Effect.forEach(rest, (command) => Effect.result(send(command)), { concurrency: 16 }),
          Effect.sleep("300 millis").pipe(Effect.andThen(killOne(stack))),
        ],
        { concurrency: "unbounded" },
      );
      const [results, killed] = outcomes;
      const lost = rest.filter((_, i) => results[i]!._tag === "Failure");
      yield* Effect.log(`killed ${killed}; ${lost.length} of ${rest.length} sends failed`);
      // A send that failed may have committed: sent again under its id, it counts once.
      yield* Effect.forEach(
        lost,
        (command) => untilAnswered(`/increment/${command.id}?by=1&command=${command.command}`),
        {
          concurrency: 8,
          discard: true,
        },
      );
      for (const id of counters) {
        const sent = commands.filter((command) => command.id === id).length;
        expect(yield* untilAnswered(`/counter/${id}`)).toEqual({ total: sent });
        // Every accepted event reaches the view once.
        expect(
          yield* eventually<{ total: number; increments: number }>(
            `/total/${id}`,
            (view) => view.increments >= sent,
          ),
        ).toEqual({ total: sent, increments: sent });
        // The policy started one saga run, and its step committed once.
        expect(
          yield* eventually<{ total: number }>(`/echo/${id}`, (echo) => echo.total > 0),
        ).toEqual({ total: 1 });
      }
      yield* bothRunning(stack, killed);
    }),
    options,
  );

  test(
    "a scheduled command still runs after its runner is killed",
    Effect.gen(function* () {
      const holds = Array.from({ length: 6 }, (_, i) => fresh(`hold${i}`));
      for (const id of holds) expect(yield* call(`/place/${id}`)).toEqual({ status: "held" });
      // Each expiry is armed: the policy's delivery ran on the hold's runner.
      yield* Effect.sleep("2 seconds");
      const killed = yield* killOne(stack);
      for (const id of holds) {
        expect(
          yield* eventually<{ status: string }>(`/hold/${id}`, (hold) => hold.status === "expired"),
        ).toEqual({ status: "expired" });
      }
      yield* bothRunning(stack, killed);
    }),
    options,
  );

  test(
    "a cancelled command stays cancelled after its runner is killed",
    Effect.gen(function* () {
      const holds = Array.from({ length: 6 }, (_, i) => fresh(`release${i}`));
      for (const id of holds) {
        yield* call(`/place/${id}`);
        expect(yield* call(`/release/${id}`)).toEqual({ status: "released" });
      }
      // The cancels are delivered before the kill.
      yield* Effect.sleep("2 seconds");
      const killed = yield* killOne(stack);
      yield* bothRunning(stack, killed);
      // Past every hold's window, on whichever runner now owns it.
      yield* Effect.sleep("10 seconds");
      for (const id of holds)
        expect(yield* untilAnswered(`/hold/${id}`)).toEqual({ status: "released" });
    }),
    options,
  );
};
