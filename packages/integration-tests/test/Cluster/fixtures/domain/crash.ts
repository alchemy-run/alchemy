import * as NodeChildProcess from "node:child_process";
/**
 * Crash cases for the Domain host on Effect Cluster: one of the pool's two
 * runners is killed with SIGKILL while it works, and the cases check what
 * the other runner (and the one Swarm starts again) makes of it.
 */
import { expect } from "@alchemy.run/test";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { ConformanceApi } from "../../../Domain/conformance/model.ts";

type TestFn = (
  name: string,
  effect: Effect.Effect<void, any, any>,
  options?: { readonly timeout?: number; readonly exclusive?: boolean },
) => void;

export interface CrashOptions {
  readonly test: TestFn;
  /** The front's URL, known once the suite deploys it. */
  readonly url: () => string;
  /** The deployed stack and stage: the runners are the Swarm tasks of its pool service. */
  readonly stack: { readonly name: string; readonly stage: string };
}

/** A `docker` command that exited with an error. */
class DockerCommandFailed extends Data.TaggedError("DockerCommandFailed")<{
  readonly args: ReadonlyArray<string>;
  readonly stderr: string;
}> {}

/** The pool has no runner left to kill, or a route answered with an error. */
class CrashCaseFailed extends Data.TaggedError("CrashCaseFailed")<{
  readonly message: string;
}> {}

export const docker = (args: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    const result = NodeChildProcess.spawnSync("docker", args, { encoding: "utf8" });
    return result.status === 0
      ? Effect.succeed(result.stdout.trim())
      : Effect.fail(new DockerCommandFailed({ args, stderr: result.stderr.trim() }));
  });

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
const runners = Effect.fn(function* (stack: CrashOptions["stack"]) {
  const service = yield* poolService(stack);
  const ids = yield* docker([
    "ps",
    "--filter",
    `label=com.docker.swarm.service.name=${service}`,
    "--format",
    "{{.ID}}",
  ]);
  return ids === "" ? [] : ids.split("\n");
});

/** SIGKILL one runner: no shutdown, no shard handoff. Swarm starts a new task in its place. */
const killOne = Effect.fn(function* (stack: CrashOptions["stack"]) {
  const [victim] = yield* runners(stack);
  if (victim === undefined) {
    return yield* new CrashCaseFailed({ message: "the pool has no running runner" });
  }
  yield* docker(["kill", "--signal", "KILL", victim]);
  return victim;
});

/**
 * Freeze one runner with `docker pause` and run `during` while it is
 * frozen; the runner is resumed however `during` ends. A frozen process
 * keeps its Postgres sessions open, so its shard locks end only when the
 * lock session idles out (`shardLockExpiration`, 35 s), and the other
 * runner then takes its shards.
 */
const frozen = <A, E, R>(
  stack: CrashOptions["stack"],
  during: (resume: Effect.Effect<void, DockerCommandFailed>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const [victim] = yield* runners(stack);
    if (victim === undefined) {
      return yield* new CrashCaseFailed({ message: "the pool has no running runner" });
    }
    yield* docker(["pause", victim]);
    let paused = true;
    const resume = Effect.suspend(() =>
      paused
        ? docker(["unpause", victim]).pipe(Effect.tap(() => Effect.sync(() => (paused = false))))
        : Effect.void,
    ).pipe(Effect.asVoid);
    return yield* during(resume).pipe(Effect.ensuring(Effect.ignore(resume)));
  });

/** Wait until the pool runs two runners again, neither of them `killed`. */
const bothRunning = (stack: CrashOptions["stack"], killed: string) =>
  runners(stack).pipe(
    Effect.filterOrFail(
      (running) => running.length === 2 && !running.includes(killed),
      () => "not yet" as const,
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );

/** An id no earlier run used: these cases' counters and holds are never reset. */
const fresh = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

const get = <T>(base: string, path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${base}${path}`);
    if (response.status !== 200) {
      return yield* new CrashCaseFailed({
        message: `${path} answered ${response.status}: ${yield* response.text}`,
      });
    }
    return (yield* response.json) as T;
  }).pipe(Effect.timeout("30 seconds"));

/** How long a case waits for the cluster to recover: the dead runner's shards move on. */
const RECOVERY = 180_000;

export const crash = ({ test, url, stack }: CrashOptions) => {
  const call = <T>(path: string) => Effect.suspend(() => get<T>(url(), path));
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
    "a runner frozen past its shard lock commits no command another runner decided from the same version, and live reads see every commit",
    Effect.gen(function* () {
      const counters = Array.from({ length: 8 }, (_, i) => fresh(`freeze${i}`));
      // Every command id a caller saw accepted, per counter.
      const accepted = new Map(counters.map((id) => [id, new Set<string>()]));
      // Sent and not yet answered: sent again at the end, under the same id.
      const unanswered = new Map<string, string>();
      // No timeout of its own: a call in flight to the frozen runner waits out the freeze.
      const send = (id: string, command: string) =>
        Effect.gen(function* () {
          unanswered.set(command, id);
          const client = yield* HttpClient.HttpClient;
          const response = yield* client.get(`${url()}/increment/${id}?by=1&command=${command}`);
          const body = (yield* response.json) as { accepted?: number };
          if (response.status === 200 && body.accepted !== undefined) {
            accepted.get(id)!.add(command);
            unanswered.delete(command);
          }
        }).pipe(Effect.timeout("120 seconds"), Effect.ignore);
      /**
       * Callers per counter, each sending one command after another for
       * `sending`. A caller then stops sending, but a call it has in flight
       * runs to its answer: those are the commands the frozen runner holds.
       */
      const load = (callers: number, gap: Duration.Input, sending: Duration.Input) =>
        Effect.gen(function* () {
          let stopped = false;
          yield* Effect.forkChild(
            Effect.sleep(sending).pipe(Effect.andThen(Effect.sync(() => (stopped = true)))),
          );
          yield* Effect.forEach(
            counters.flatMap((id) => Array.from({ length: callers }, () => id)),
            (id) =>
              Effect.andThen(
                Effect.suspend(() => send(id, fresh("cmd"))),
                Effect.sleep(gap),
              ).pipe(Effect.repeat({ while: () => !stopped })),
            { concurrency: "unbounded", discard: true },
          );
        });
      // The last total each counter's live read was pushed, from a read
      // opened on the runner that took the frozen runner's shards.
      const pushed = new Map<string, number>();
      const api = yield* ConformanceApi.clientWebSocket(`${url()}/api`);
      const watch = (id: string) =>
        api.CounterTotal.watch(id).pipe(
          Stream.runForEach((frame) => Effect.sync(() => pushed.set(id, frame.state?.total ?? 0))),
          Effect.ignore,
          Effect.forkScoped,
        );
      // Every counter exists, so its runner owns it, before the freeze.
      for (const id of counters) yield* send(id, fresh("cmd"));
      yield* Effect.all(
        [
          // The first callers leave commands in flight on the frozen runner.
          load(2, "10 millis", "8 seconds"),
          Effect.sleep("6 seconds").pipe(
            Effect.andThen(
              frozen(stack, (resume) =>
                Effect.all(
                  [
                    // Once the other runner has the shards: live reads, then new commands.
                    Effect.sleep("40 seconds").pipe(
                      Effect.andThen(Effect.forEach(counters, watch, { discard: true })),
                      Effect.andThen(Effect.sleep("4 seconds")),
                      Effect.andThen(load(3, "100 millis", "25 seconds")),
                    ),
                    // Resumed while those callers still send.
                    Effect.sleep("56 seconds").pipe(Effect.andThen(resume)),
                  ],
                  { concurrency: "unbounded", discard: true },
                ),
              ),
            ),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.log(
        `freeze: ${[...accepted.values()].reduce((n, ids) => n + ids.size, 0)} answered, ${unanswered.size} unanswered, ${pushed.size} live reads pushed`,
      );
      // A send without an answer may have committed: sent again under its id, it counts once.
      for (const [command, id] of [...unanswered]) {
        yield* untilAnswered<{ accepted: number }>(`/increment/${id}?by=1&command=${command}`);
        accepted.get(id)!.add(command);
      }
      for (const id of counters) {
        const sent = accepted.get(id)!.size;
        // One event per accepted command: none lost to another accepted at the same version.
        expect(yield* untilAnswered(`/counter/${id}`)).toEqual({ total: sent });
        expect(
          yield* eventually<{ total: number; increments: number }>(
            `/total/${id}`,
            (view) => view.increments >= sent,
          ),
        ).toEqual({ total: sent, increments: sent });
      }
      // A live read is pushed every commit, the frozen runner's included.
      for (const id of counters) {
        const sent = accepted.get(id)!.size;
        const last = yield* Effect.sync(() => pushed.get(id)).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (total) => total === sent,
            times: 30,
          }),
        );
        expect({ id, pushed: last }).toEqual({ id, pushed: sent });
      }
    }).pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
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
