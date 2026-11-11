/**
 * Contract cases for the Domain host on Effect Cluster: what a deployment
 * relies on when runners are replaced, restarted or killed, and when a
 * projection writes to the host's own database.
 */
import { expect } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { FAILS_ONCE, ROWS_TABLE } from "./contract-model.ts";
import { type CrashOptions, docker, fresh, get, poolService, RECOVERY, runners } from "./crash.ts";

/** Wait until the pool runs two runners again, none of them one of `old`. */
const replaced = (stack: CrashOptions["stack"], old: ReadonlyArray<string>) =>
  Effect.sync(() => runners(stack)).pipe(
    Effect.filterOrFail(
      (running) => running.length === 2 && running.every((id) => !old.includes(id)),
      () => "not yet" as const,
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 120 }),
  );

/** Wait until the pool's last service update has finished. */
const updated = (stack: CrashOptions["stack"]) =>
  Effect.sync(() =>
    docker(["service", "inspect", "--format", "{{.UpdateStatus.State}}", poolService(stack)]),
  ).pipe(
    Effect.filterOrFail(
      (state) => state === "completed",
      (state) => `update ${state || "not started"}`,
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 150 }),
  );

/** Start a service update of the pool that replaces every runner, and return at once. */
const update = (
  stack: CrashOptions["stack"],
  order: "start-first" | "stop-first",
  parallelism: number,
) =>
  Effect.sync(() =>
    docker([
      "service",
      "update",
      "--detach",
      "--force",
      "--update-order",
      order,
      "--update-parallelism",
      String(parallelism),
      "--update-delay",
      "2s",
      poolService(stack),
    ]),
  );

/** Run SQL in the cluster's database; one value per row. */
const query = (stack: CrashOptions["stack"], text: string) =>
  Effect.try({
    try: () => {
      const service = docker([
        "service",
        "ls",
        "--filter",
        "label=alchemy::id=ClusterDomainPostgres",
        "--filter",
        `label=alchemy::stack=${stack.name}`,
        "--filter",
        `label=alchemy::stage=${stack.stage}`,
        "--format",
        "{{.Name}}",
      ]);
      const container = docker([
        "ps",
        "--filter",
        `label=com.docker.swarm.service.name=${service}`,
        "--format",
        "{{.ID}}",
      ]).split("\n")[0]!;
      const out = docker([
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "cluster",
        "-tAc",
        text,
      ]);
      return out === "" ? [] : out.split("\n");
    },
    catch: (error) => error as Error,
  });

export const contract = ({ test, url, stack }: CrashOptions) => {
  const call = <T>(path: string) => get<T>(url, path);
  const untilAnswered = <T>(path: string) =>
    call<T>(path).pipe(
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: RECOVERY / 1_000 }),
    );
  const eventually = <T>(path: string, until: (value: T) => boolean) =>
    untilAnswered<T>(path).pipe(
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until, times: RECOVERY / 1_000 }),
    );
  // Alone: replacing runners fails any other case's calls.
  const options = { timeout: 600_000, exclusive: true };

  test(
    "a deploy that starts each new runner before it stops the old one loses no command",
    Effect.gen(function* () {
      const counters = Array.from({ length: 6 }, (_, i) => fresh(`deploy${i}`));
      const old = runners(stack);
      yield* update(stack, "start-first", 1);
      // Commands go on while old and new runners overlap, and each old one stops.
      const sent = new Map(counters.map((id) => [id, 0]));
      let n = 0;
      while (runners(stack).some((id) => old.includes(id)) && n < 400) {
        yield* Effect.forEach(
          counters,
          (id) =>
            untilAnswered(`/increment/${id}?by=1&command=${id}-${n}`).pipe(
              Effect.tap(() => Effect.sync(() => sent.set(id, sent.get(id)! + 1))),
            ),
          { concurrency: "unbounded", discard: true },
        );
        n++;
      }
      yield* updated(stack);
      yield* replaced(stack, old);
      yield* Effect.log(`${n} rounds of ${counters.length} commands during the deploy`);
      expect(n).toBeGreaterThan(0);
      for (const id of counters) {
        const total = sent.get(id)!;
        expect(yield* untilAnswered(`/counter/${id}`)).toEqual({ total });
        expect(
          yield* eventually<{ total: number; increments: number }>(
            `/total/${id}`,
            (view) => view.increments >= total,
          ),
        ).toEqual({ total, increments: total });
      }
    }),
    options,
  );

  test(
    "timers survive a restart of every runner",
    Effect.gen(function* () {
      const placed = Array.from({ length: 4 }, (_, i) => fresh(`restart-hold${i}`));
      const released = Array.from({ length: 4 }, (_, i) => fresh(`restart-release${i}`));
      for (const id of [...placed, ...released]) yield* call(`/place/${id}`);
      for (const id of released)
        expect(yield* call(`/release/${id}`)).toEqual({ status: "released" });
      // Every expiry is armed and every cancel delivered before the restart.
      yield* Effect.sleep("2 seconds");
      const old = runners(stack);
      // Every runner stops, then new ones start: no runner is left to hand shards to.
      yield* update(stack, "stop-first", 2);
      yield* updated(stack);
      yield* replaced(stack, old);
      for (const id of placed) {
        expect(
          yield* eventually<{ status: string }>(`/hold/${id}`, (hold) => hold.status === "expired"),
        ).toEqual({ status: "expired" });
      }
      for (const id of released)
        expect(yield* untilAnswered(`/hold/${id}`)).toEqual({ status: "released" });
    }),
    options,
  );

  test(
    "a saga killed during a step runs the step again, and its sends commit once",
    Effect.gen(function* () {
      const jobs = Array.from({ length: 4 }, (_, i) => fresh(`job${i}`));
      for (const id of jobs) yield* call(`/contract/job/${id}`);
      // Each run's first step has sent its command and is waiting.
      yield* Effect.forEach(
        jobs,
        (id) => eventually<{ count: number }>(`/contract/mark/${id}`, (mark) => mark.count >= 1),
        { concurrency: "unbounded", discard: true },
      );
      const old = runners(stack);
      for (const id of old) docker(["kill", "--signal", "KILL", id]);
      yield* replaced(stack, old);
      for (const id of jobs) {
        // The first step ran again under the same command ids: two sends in all.
        expect(
          yield* eventually<{ count: number }>(`/contract/mark/${id}`, (mark) => mark.count >= 2),
        ).toEqual({ count: 2 });
      }
      // Nothing more arrives late.
      yield* Effect.sleep("5 seconds");
      for (const id of jobs) expect(yield* call(`/contract/mark/${id}`)).toEqual({ count: 2 });
    }),
    options,
  );

  test(
    "a projection's rows and its checkpoint commit in one transaction",
    Effect.gen(function* () {
      const id = fresh("tally");
      let stream = "";
      // The second input fails after its row is written; its run must leave no row.
      for (const by of [1, FAILS_ONCE, 2]) {
        stream = (yield* call<{ stream: string }>(`/contract/add/${id}?by=${by}`)).stream;
      }
      const rows = () =>
        query(
          stack,
          `SELECT seq || ':' || by_ FROM ${ROWS_TABLE} WHERE stream = '${stream}' ORDER BY seq`,
        );
      const written = yield* rows().pipe(
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (found) => found.length >= 3,
          times: 60,
        }),
      );
      expect(written).toEqual(["1:1", `2:${FAILS_ONCE}`, "3:2"]);
    }),
    { timeout: 120_000 },
  );
};
