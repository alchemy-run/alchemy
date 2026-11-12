/**
 * A saga's steps on Effect Cluster's workflow engine, as the Domain host
 * registers them: the engine runs on an in-memory cluster (`TestRunner`),
 * and the model's aggregates are in memory.
 */
import * as Domain from "@alchemy.run/domain";
import { sagaEngine } from "@alchemy.run/domain/EffectCluster";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import { ClusterWorkflowEngine, TestRunner } from "effect/cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Activity, WorkflowEngine } from "effect/workflow";

class Opened extends Domain.Event("Opened", { balance: Schema.Number }) {}
class Debited extends Domain.Event("Debited", { transfer: Schema.String, amount: Schema.Number }) {}

class Open extends Domain.Command("Open", {
  target: Schema.String,
  input: { balance: Schema.Number },
  events: [Opened],
}) {}
class Debit extends Domain.Command("Debit", {
  target: Schema.String,
  input: { transfer: Schema.String, amount: Schema.Number },
  events: [Debited],
}) {}

class Wallet extends Domain.Aggregate("Wallet", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number }),
  initial: { balance: 0 },
  commands: [Open, Debit],
  decide: {
    Open: (_, cmd) => [new Opened({ balance: cmd.balance })],
    Debit: (_, cmd) => [new Debited({ transfer: cmd.transfer, amount: cmd.amount })],
  },
  evolve: {
    Opened: (_, e) => ({ balance: e.balance }),
    Debited: (s, e) => ({ balance: s.balance - e.amount }),
  },
}) {}

// A step that sends a debit, then fails its first attempt: the retry sends the
// same command again, which the wallet must apply once.
class Flaky extends Schema.TaggedError<Flaky>()("Flaky", {}) {}

class DebitTwice extends Domain.Saga("DebitTwice", {
  key: Schema.String,
  input: { from: Schema.String, amount: Schema.Number },
}) {}

const DebitTwiceLive = DebitTwice.toLayer(
  Effect.gen(function* () {
    const wallets = yield* Wallet;
    return Effect.fn(function* ({ key, from, amount }) {
      yield* Activity.make({
        name: "debit",
        error: Flaky,
        execute: Effect.gen(function* () {
          yield* wallets.send(from, new Debit({ transfer: key, amount })).pipe(Effect.orDie);
          if ((yield* Activity.CurrentAttempt) === 1) return yield* new Flaky();
        }),
      }).pipe(Activity.retry({ times: 2 }), Effect.orDie);
    });
  }),
);

class Retries extends Domain.Model("Retries", {
  aggregates: [Wallet],
  sagas: [DebitTwice],
}) {}

/** Effect Cluster's engine on an in-memory cluster, as the host gives it to a model's sagas. */
const Engine = Layer.effect(
  WorkflowEngine.WorkflowEngine,
  Effect.map(WorkflowEngine.WorkflowEngine, sagaEngine),
).pipe(Layer.provide(ClusterWorkflowEngine.layer), Layer.provide(TestRunner.layer));

// Aggregates in memory; the sagas' engine is the cluster's, not the in-memory one.
const Live = Retries.layer(DebitTwiceLive).pipe(Layer.provide(Engine), Layer.provide(InMemory));

describe("Domain on Effect Cluster: saga steps", { tags: ["unit", "local"] }, () => {
  it.live("a step that runs again sends the same commands", () =>
    Effect.gen(function* () {
      const wallets = yield* Wallet;
      const debits = yield* DebitTwice;
      yield* wallets.send(Wallet.ref("alice"), new Open({ balance: 100 }));
      const run = yield* debits.start("t-1", { from: "alice", amount: 40 });
      yield* run.result;
      // Debited once: the retry's send had the same command id.
      expect((yield* wallets.get(Wallet.ref("alice"))).balance).toBe(60);
    }).pipe(Effect.provide(Live)),
  );
});
