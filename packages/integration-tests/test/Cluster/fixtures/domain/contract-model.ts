/**
 * The model of the host contract cases on Effect Cluster: a saga whose step
 * sends a command and then waits, and a projection that writes its rows
 * through the host's own Postgres client.
 */
import * as Domain from "@alchemy.run/domain";
import * as DomainCluster from "@alchemy.run/domain/EffectCluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";

export class Noted extends Domain.Event("Noted") {}
export class Note extends Domain.Command("Note", {
  target: Schema.String,
  events: [Noted],
}) {}

/** Counts the commands a saga's steps sent it. */
export class Mark extends Domain.Aggregate("Mark", {
  id: Schema.String,
  state: Schema.Struct({ count: Schema.Int }),
  initial: { count: 0 },
  commands: [Note],
  decide: { Note: () => [new Noted()] },
  evolve: { Noted: (state) => ({ count: state.count + 1 }) },
}) {}

export class JobStarted extends Domain.Event("JobStarted") {}
export class StartJob extends Domain.Command("StartJob", {
  target: Schema.String,
  events: [JobStarted],
}) {}

export class Job extends Domain.Aggregate("Job", {
  id: Schema.String,
  state: Schema.Struct({ started: Schema.Boolean }),
  initial: { started: false },
  commands: [StartJob],
  decide: { StartJob: () => [new JobStarted()] },
  evolve: { JobStarted: () => ({ started: true }) },
}) {}

/** How long the first step waits after its send: long enough to kill its runner in. */
export const STEP_WAIT = "8 seconds";

/** Two steps; the first sends, then waits. */
export class SlowJob extends Domain.Saga("SlowJob", { key: Schema.String, input: {} }) {}

const SlowJobLive = SlowJob.toLayer(
  Effect.gen(function* () {
    const marks = yield* Mark;
    return Effect.fn(function* ({ key }) {
      yield* Activity.make({
        name: "first",
        execute: marks
          .send(key, new Note())
          .pipe(Effect.andThen(Effect.sleep(STEP_WAIT)), Effect.orDie),
      });
      yield* Activity.make({
        name: "second",
        execute: marks.send(key, new Note()).pipe(Effect.orDie),
      });
    });
  }),
);

export class RunJob extends Domain.Policy("RunJob", { from: Job, on: [JobStarted] }) {}

const RunJobLive = RunJob.toLayer(
  Effect.gen(function* () {
    const jobs = yield* SlowJob;
    return Effect.fn(function* ({ source }) {
      yield* jobs.start(source, {});
    });
  }),
);

export class Added extends Domain.Event("Added", { by: Schema.Int }) {}
export class Add extends Domain.Command("Add", {
  target: Schema.String,
  input: { by: Schema.Int },
  events: [Added],
}) {}

export class Tally extends Domain.Aggregate("Tally", {
  id: Schema.String,
  state: Schema.Struct({ total: Schema.Int }),
  initial: { total: 0 },
  commands: [Add],
  decide: { Add: (_, command) => [new Added({ by: command.by })] },
  evolve: { Added: (state, event) => ({ total: state.total + event.by }) },
}) {}

/** The table {@link TallyRows} writes: one row per event, inserted (not upserted). */
export const ROWS_TABLE = "contract_tally_rows";
/** An `Added` by this much fails its first run, after its row is written. */
export const FAILS_ONCE = 13;

export class TallyRows extends Domain.Projection("TallyRows", {
  from: [Tally],
  key: Tally,
  on: [Added],
}) {}

/** The inputs that already failed once, in this runner. */
const failed = new Set<string>();

const TallyRowsLive = TallyRows.toLayer(
  Effect.succeed(
    Effect.fn(function* (batch) {
      const sql = yield* DomainCluster.hostSql;
      yield* sql`CREATE TABLE IF NOT EXISTS ${sql(ROWS_TABLE)} (
        stream TEXT NOT NULL, seq INT NOT NULL, by_ INT NOT NULL, PRIMARY KEY (stream, seq)
      )`.pipe(Effect.orDie);
      for (const { envelope, event } of batch) {
        // A plain insert: a row written twice fails the run.
        yield* sql`INSERT INTO ${sql(ROWS_TABLE)} (stream, seq, by_)
          VALUES (${envelope.stream}, ${envelope.seq}, ${event.by})`.pipe(Effect.orDie);
        const input = `${envelope.stream}:${envelope.seq}`;
        if (event.by === FAILS_ONCE && !failed.has(input)) {
          failed.add(input);
          return yield* Effect.die(new Error(`TallyRows: ${input} fails its first run`));
        }
      }
    }),
  ),
);

export class Contract extends Domain.Model("Contract", {
  aggregates: [Mark, Job, Tally],
  policies: [RunJob],
  sagas: [SlowJob],
  projections: [TallyRows],
}) {}

export const ContractLive = Contract.layer(Layer.mergeAll(SlowJobLive, RunJobLive, TallyRowsLive));
