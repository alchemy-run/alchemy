/**
 * How long a command takes on a Domain platform, strong and eventual, timed
 * inside the front (so the caller's own network is not in the numbers) by
 * its `/bench` route. Each cell is one shape of model (see
 * `latency-model.ts`), one `consistency`, and warm or new instances; a cell
 * prints a `BENCH` line of JSON, and the run ends with a table.
 *
 * - `DOMAIN_BENCH_SAMPLES` (default 40) commands per cell; the figures in
 *   `packages/domain/docs/consistency-latency.md` are from 200 to 300.
 * - `DOMAIN_BENCH_LANES` (default 4) requests at once, each on keys of its own.
 * - `DOMAIN_BENCH_SHAPES` (default all) comma-separated shapes.
 * - `DOMAIN_BENCH_CELLS` (default `steady`; `steady,idle` for both): `steady` sends commands one
 *   after another, to warm instances and to new ones; `idle` sends one
 *   command to each of many instances left alone for `DOMAIN_BENCH_IDLE`
 *   seconds (default 45), long enough for a platform to unload them.
 */
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

type TestFn = (
  name: string,
  effect: Effect.Effect<void, any, any>,
  options?: { readonly timeout?: number; readonly tags?: ReadonlyArray<string> },
) => void;

export interface LatencyOptions {
  readonly test: TestFn;
  /** Where the platform runs: on this machine, or in a cloud. */
  readonly kind: "local" | "live";
  /** What the numbers are of: the platform, and where it runs. */
  readonly label: string;
  /** The front's base URL, once it is deployed. */
  readonly url: Effect.Effect<string, any, any>;
}

const SAMPLES = Number(process.env.DOMAIN_BENCH_SAMPLES ?? "40");
const LANES = Number(process.env.DOMAIN_BENCH_LANES ?? "4");
/** Commands per request: few enough to stay under a Worker's subrequest limit. */
const PER_REQUEST = 10;
const CELLS = (process.env.DOMAIN_BENCH_CELLS ?? "steady").split(",");
const IDLE_SECONDS = Number(process.env.DOMAIN_BENCH_IDLE ?? "45");
/** Instances an idle round leaves alone, then sends one command each. */
const IDLE_KEYS = 40;
const IDLE_ROUNDS = 3;
const SHAPES = (process.env.DOMAIN_BENCH_SHAPES ?? "bare,one,four,chain,shared,counter")
  .split(",")
  .filter((shape) => shape !== "");

const Timings = Schema.Struct({
  ms: Schema.Array(Schema.Number),
  behind: Schema.Array(Schema.Number),
  reads: Schema.Array(Schema.Number),
});
type Timings = typeof Timings.Type;

export interface Summary {
  readonly n: number;
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
}

export const summarize = (samples: ReadonlyArray<number>): Summary => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return {
    n: sorted.length,
    min: sorted[0]!,
    mean: Math.round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length),
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1]!,
  };
};

const bench = (
  failed: { count: number },
  base: string,
  id: string,
  query: Record<string, string | number>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const search = Object.entries(query)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join("&");
    const response = yield* client.get(`${base}/bench/${id}?${search}`);
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`/bench/${id}?${search} answered ${response.status}: ${yield* response.text}`),
      );
    }
    return yield* Schema.decodeUnknownEffect(Timings)(yield* response.json);
  }).pipe(
    // A failed request (a `ConsistencyTimeout`, a platform error) is counted, then sent again.
    Effect.tapError(() => Effect.sync(() => (failed.count += 1))),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 3 }),
  );

export const latency = ({ test, kind, label, url }: LatencyOptions) =>
  test(
    `latency: how long a command takes, strong and eventual (${label})`,
    Effect.gen(function* () {
      const base = yield* url;
      const run = crypto.randomUUID().slice(0, 8);
      const failed = { count: 0 };
      const rows: Array<Record<string, string | number>> = [];
      const report = (cell: string, what: string, samples: ReadonlyArray<number>) =>
        Effect.sync(() => {
          const row = { platform: label, cell, what, ...summarize(samples) };
          rows.push(row);
          console.log(`BENCH ${JSON.stringify(row)}`);
        });
      /** `SAMPLES` commands of one cell, over `LANES` requests at a time. */
      const cell = (
        shape: string,
        consistency: "strong" | "eventual",
        fresh: boolean,
        lag = false,
      ) =>
        Effect.gen(function* () {
          const name = `${shape} ${consistency} ${fresh ? "new" : "warm"}${lag ? " lag" : ""}`;
          const lane = (index: number) =>
            `${run}-${shape}-${consistency[0]}${fresh ? "n" : "w"}${lag ? "l" : ""}-${index}`;
          const query = { shape, consistency, fresh: fresh ? 1 : 0, lag: lag ? 1 : 0 };
          // A warm instance has taken a command already: its objects exist and are loaded.
          if (!fresh) {
            yield* Effect.forEach(
              Array.from({ length: LANES }, (_, index) => index),
              (index) => bench(failed, base, lane(index), { ...query, n: 2 }),
              { concurrency: LANES },
            );
          }
          const rounds = Math.ceil(SAMPLES / (LANES * PER_REQUEST));
          const timings: Array<Timings> = [];
          for (let round = 0; round < rounds; round++) {
            timings.push(
              ...(yield* Effect.forEach(
                Array.from({ length: LANES }, (_, index) => index),
                (index) =>
                  bench(failed, base, fresh ? `${lane(index)}-${round}` : lane(index), {
                    ...query,
                    n: PER_REQUEST,
                  }),
                { concurrency: LANES },
              )),
            );
          }
          yield* report(
            name,
            "command",
            timings.flatMap((timing) => timing.ms),
          );
          if (lag) {
            yield* report(
              name,
              "view has it after",
              timings.flatMap((timing) => timing.behind),
            );
            yield* report(
              name,
              "reads until it has",
              timings.flatMap((timing) => timing.reads),
            );
          }
        });
      /** One command to each of `IDLE_KEYS` instances that have been left alone. */
      const idle = (shape: string) =>
        Effect.gen(function* () {
          const keys = (consistency: string) =>
            Array.from(
              { length: IDLE_KEYS },
              (_, index) => `${run}-${shape}-idle-${consistency[0]}-${index}`,
            );
          const each = (consistency: "strong" | "eventual", n: number) =>
            Effect.forEach(
              keys(consistency),
              (key) => bench(failed, base, key, { shape, consistency, fresh: 0, lag: 0, n }),
              { concurrency: LANES },
            );
          const samples = { eventual: [] as Array<number>, strong: [] as Array<number> };
          yield* Effect.all([each("eventual", 2), each("strong", 2)], { concurrency: 2 });
          for (let round = 0; round < IDLE_ROUNDS; round++) {
            yield* Effect.sleep(`${IDLE_SECONDS} seconds`);
            for (const consistency of ["eventual", "strong"] as const) {
              for (const timing of yield* each(consistency, 1))
                samples[consistency].push(...timing.ms);
            }
          }
          yield* report(`${shape} eventual idle ${IDLE_SECONDS}s`, "command", samples.eventual);
          yield* report(`${shape} strong idle ${IDLE_SECONDS}s`, "command", samples.strong);
        });
      if (CELLS.includes("idle")) {
        for (const shape of SHAPES) yield* idle(shape);
      }
      for (const shape of CELLS.includes("steady") ? SHAPES : []) {
        for (const fresh of [false, true]) {
          yield* cell(shape, "eventual", fresh);
          yield* cell(shape, "strong", fresh);
        }
      }
      // After an eventual command: how long until the view has it. After a
      // strong one it has it already, so this times one read of the view.
      if (CELLS.includes("steady") && SHAPES.includes("one")) {
        yield* cell("one", "eventual", false, true);
        yield* cell("one", "strong", false, true);
      }
      yield* Effect.sync(() => {
        console.log(`BENCH ${JSON.stringify({ platform: label, failedRequests: failed.count })}`);
        console.table(rows);
      });
    }),
    { timeout: 3_600_000, tags: [kind] },
  );
