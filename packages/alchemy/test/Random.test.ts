import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { formatYamlLines } from "@/Cli/PropertyDiff.ts";
import * as Provider from "@/Provider";
import { makeRandom, Random, RandomProvider } from "@/Random";
import { Stack } from "@/Stack";
import { inMemoryState, isResourceState, type ResourceState, State } from "@/State";
import { encodeState, reviveState } from "@/State/StateEncoding.ts";

const { test } = Test.make({
  providers: RandomProvider(),
  state: inMemoryState(),
});

const savedRandom = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stack = yield* Stack;
  return (yield* state.get({ stack: stack.name, stage: stack.stage, fqn })) as
    | ResourceState
    | undefined;
});

describe("Alchemy.Random", { tags: ["unit", "local"] }, () => {
  test.provider("adopts an existing redacted value on first deploy", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const existing = "migrated-key-not-to-rotate";
      const output = yield* stack.deploy(
        Random("migrated-value", { initial: Redacted.make(existing) }),
      );
      expect(Redacted.isRedacted(output.text)).toBe(true);
      expect(Redacted.value(output.text)).toBe(existing);

      const revived = JSON.parse(
        JSON.stringify(encodeState({ text: output.text })),
        reviveState,
      ) as {
        text: Redacted.Redacted<string>;
      };
      expect(Redacted.isRedacted(revived.text)).toBe(true);
      expect(Redacted.value(revived.text)).toBe(existing);

      yield* stack.destroy();
      const replacement = yield* stack.deploy(
        Random("migrated-value", { initial: Redacted.make("new-after-destroy") }),
      );
      expect(Redacted.value(replacement.text)).toBe("new-after-destroy");

      yield* stack.destroy();
    }),
  );

  test.provider("preserves the saved secret when initial and bytes change", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Random("stable-migrated-value", { initial: Redacted.make("original-value") }),
      );
      const plan = yield* stack.plan(
        Random("stable-migrated-value", {
          bytes: 8,
          initial: Redacted.make("replacement-that-must-be-ignored"),
        }),
      );
      expect(plan.resources["stable-migrated-value"]?.action).toBe("noop");

      const changed = yield* stack.deploy(
        Random("stable-migrated-value", {
          bytes: 8,
          initial: Redacted.make("replacement-that-must-be-ignored"),
        }),
      );
      const absent = yield* stack.deploy(Random("stable-migrated-value"));

      expect(Redacted.value(first.text)).toBe("original-value");
      expect(Redacted.value(changed.text)).toBe("original-value");
      expect(Redacted.value(absent.text)).toBe("original-value");

      yield* stack.destroy();
    }),
  );

  test.provider("accepts a one-time Effect initial and never executes it again", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      let evaluations = 0;
      const first = yield* stack.deploy(
        Random("effect-seed-once", {
          initial: Effect.sync(() => {
            evaluations++;
            return Redacted.make("imported-from-effect");
          }),
        }),
      );
      expect(Redacted.value(first.text)).toBe("imported-from-effect");
      expect(evaluations).toBe(1);

      const next = yield* stack.deploy(
        Random("effect-seed-once", {
          initial: Effect.sync(() => {
            evaluations++;
            return Redacted.make("must-never-rotate");
          }),
        }),
      );
      expect(Redacted.value(next.text)).toBe("imported-from-effect");
      expect(evaluations).toBe(1);

      yield* stack.destroy();
    }),
  );

  test.provider("evaluates a deferred seed using the caller's Effect service", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const MigrationKey = Context.Service<Redacted.Redacted<string>>(
        "Alchemy.Random.Test.MigrationKey",
      );
      const seed = Effect.gen(function* () {
        return yield* MigrationKey;
      });
      const first = yield* stack
        .deploy(Random("service-seeded", { initial: seed }))
        .pipe(Effect.provideService(MigrationKey, Redacted.make("service-seeded-secret")));
      expect(Redacted.value(first.text)).toBe("service-seeded-secret");

      const next = yield* stack.deploy(Random("service-seeded", { initial: seed }));
      expect(Redacted.value(next.text)).toBe("service-seeded-secret");

      yield* stack.destroy();
    }),
  );

  test.provider(
    "persists a migrated secret only as output, not a redundant initial prop",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const secret = "ONE_SHOT_SECRET_NOT_DUPLICATED_IN_STATE";
        const created = yield* stack.deploy(
          Random("one-shot-state-secret", { initial: Redacted.make(secret) }),
        );
        expect(Redacted.value(created.text)).toBe(secret);

        const row = yield* savedRandom("one-shot-state-secret");
        expect(row?.status).toBe("created");
        expect(row?.props?.initial).toBeUndefined();
        const serialized = JSON.stringify(encodeState(row));
        expect(serialized.split(secret).length - 1).toBe(1);

        yield* stack.destroy();
      }),
  );

  test.provider("imports a secret from another Random resource output", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const existing = yield* Random("upstream-seed", {
          initial: Redacted.make("existing-upstream-secret"),
        });
        return yield* Random("downstream-secret", { initial: existing.text });
      });
      const output = yield* stack.deploy(program);
      expect(Redacted.value(output.text)).toBe("existing-upstream-secret");
      const row = yield* savedRandom("downstream-secret");
      expect(row?.props?.initial).toBeUndefined();
      expect(JSON.stringify(encodeState(row)).split("existing-upstream-secret").length - 1).toBe(1);
      const plan = yield* stack.plan(program);
      expect(plan.resources["downstream-secret"]?.action).toBe("noop");

      yield* stack.destroy();
    }),
  );

  test.provider("restores a migrated secret from a full encoded state row", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack
        .deploy(
          Random("persisted-migrated-config", {
            initial: Config.Redacted("MIGRATED_RANDOM_SECRET"),
          }),
        )
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { MIGRATED_RANDOM_SECRET: "permanent-encryption-key" } }),
          ),
        );
      expect(Redacted.value(first.text)).toBe("permanent-encryption-key");

      const original = yield* savedRandom("persisted-migrated-config");
      expect(original?.status).toBe("created");
      const encoded = JSON.stringify(encodeState(original));
      expect(encoded.split("permanent-encryption-key").length - 1).toBe(1);
      const revived = JSON.parse(encoded, reviveState) as ResourceState;
      const state = yield* yield* State;
      const active = yield* Stack;
      yield* state.set({
        stack: active.name,
        stage: active.stage,
        fqn: "persisted-migrated-config",
        value: revived,
      });

      const plan = yield* stack
        .plan(
          Random("persisted-migrated-config", {
            initial: Config.Redacted("MIGRATED_RANDOM_SECRET"),
          }),
        )
        .pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
        );
      expect(plan.resources["persisted-migrated-config"]?.action).toBe("noop");
      const recovered = yield* stack
        .deploy(
          Random("persisted-migrated-config", {
            initial: Config.Redacted("MIGRATED_RANDOM_SECRET"),
          }),
        )
        .pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
        );
      expect(Redacted.value(recovered.text)).toBe("permanent-encryption-key");

      yield* stack.destroy();
    }),
  );

  test.provider(
    "rejects a corrupted persisted Random output instead of accepting or rotating it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const id = "corrupt-existing-random";
        const first = yield* stack.deploy(
          Random(id, { initial: Redacted.make("original-secret") }),
        );
        expect(Redacted.value(first.text)).toBe("original-secret");

        const state = yield* yield* State;
        const active = yield* Stack;
        const row = yield* savedRandom(id);
        if (row?.status !== "created") return yield* Effect.die("Random state missing");
        yield* state.set({
          stack: active.name,
          stage: active.stage,
          fqn: id,
          value: { ...row, attr: { text: "corrupted-redaction" } },
        });

        const attempted = yield* Effect.result(
          stack.deploy(Random(id, { initial: Redacted.make("attacker-replacement") })),
        );
        expect(Result.isFailure(attempted)).toBe(true);
        const unchanged = yield* savedRandom(id);
        expect(unchanged?.attr?.text).toBe("corrupted-redaction");

        // Explicitly remove the bad record before cleanup; a corrupt secret
        // must never be used as authority to generate a replacement.
        yield* state.delete({ stack: active.name, stage: active.stage, fqn: id });
        yield* stack.destroy();
      }),
  );

  test.provider("does not replace a key when a deferred seed Effect fails", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const importAttempt = yield* Effect.result(
        stack.deploy(
          Random("failing-seed", {
            initial: Effect.fail({ _tag: "SeedUnavailable" as const, message: "seed unavailable" }),
          }),
        ),
      );
      expect(Result.isFailure(importAttempt)).toBe(true);
      if (Result.isFailure(importAttempt)) {
        expect(importAttempt.failure._tag).toBe("SeedUnavailable");
      }

      const recovered = yield* stack.deploy(
        Random("failing-seed", { initial: Redacted.make("recovered-original-key") }),
      );
      expect(Redacted.value(recovered.text)).toBe("recovered-original-key");
      const noop = yield* stack.plan(Random("failing-seed"));
      expect(noop.resources["failing-seed"]?.action).toBe("noop");

      yield* stack.destroy();
    }),
  );

  test.provider(
    "does not rotate a persisted key when a forced update runs without its seed",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const input = Random("forced-migrated-key", {
          initial: Config.Redacted("MIGRATED_RANDOM_SECRET"),
        });
        const original = yield* stack
          .deploy(input)
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({ env: { MIGRATED_RANDOM_SECRET: "persistent-forced-key" } }),
            ),
          );
        const missing = ConfigProvider.fromEnv({ env: {} });

        const forcedPlan = yield* stack
          .plan(input, { force: true })
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, missing));
        expect(forcedPlan.resources["forced-migrated-key"]?.action).toBe("update");

        const forced = yield* stack
          .deploy(input, { force: true })
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, missing));
        expect(Redacted.value(original.text)).toBe("persistent-forced-key");
        expect(Redacted.value(forced.text)).toBe("persistent-forced-key");

        yield* stack.destroy();
      }),
  );

  test.provider("supports an optional Config.Redacted seed that can disappear", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const random = Random("optional-config-migration", {
        initial: Config.option(Config.Redacted("MIGRATED_RANDOM_SECRET")),
      });
      const first = yield* stack
        .deploy(random)
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { MIGRATED_RANDOM_SECRET: "from-config" } }),
          ),
        );
      const next = yield* stack
        .deploy(random)
        .pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
        );

      expect(Redacted.value(first.text)).toBe("from-config");
      expect(Redacted.value(next.text)).toBe("from-config");

      yield* stack.destroy();
    }),
  );

  test.provider("accepts Config.Redacted directly on the first deployment", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack
        .deploy(
          Random("required-config-migration", {
            initial: Config.Redacted("MIGRATED_RANDOM_SECRET"),
          }),
        )
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { MIGRATED_RANDOM_SECRET: "required-config-value" } }),
          ),
        );
      expect(Redacted.value(output.text)).toBe("required-config-value");

      yield* stack.destroy();
    }),
  );

  test.provider("ignores a required Config.Redacted after the secret has been adopted", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const input = Random("required-config-stable", {
        initial: Config.Redacted("MIGRATED_RANDOM_SECRET"),
      });
      const configured = ConfigProvider.fromEnv({
        env: { MIGRATED_RANDOM_SECRET: "must-not-be-rotated" },
      });
      const removed = ConfigProvider.fromEnv({ env: {} });

      const first = yield* stack
        .deploy(input)
        .pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured));
      expect(Redacted.value(first.text)).toBe("must-not-be-rotated");

      const plan = yield* stack
        .plan(input)
        .pipe(Effect.provideService(ConfigProvider.ConfigProvider, removed));
      expect(plan.resources["required-config-stable"]?.action).toBe("noop");

      const redeployed = yield* stack
        .deploy(input)
        .pipe(Effect.provideService(ConfigProvider.ConfigProvider, removed));
      expect(Redacted.value(redeployed.text)).toBe("must-not-be-rotated");

      yield* stack.destroy();
    }),
  );

  test.provider("defers Config.Redacted inside Effect-valued resource props", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const random = Random(
        "effect-props-config",
        Effect.succeed({ initial: Config.Redacted("MIGRATED_RANDOM_SECRET") }),
      );
      const first = yield* stack
        .deploy(random)
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { MIGRATED_RANDOM_SECRET: "seeded-through-props" } }),
          ),
        );
      expect(Redacted.value(first.text)).toBe("seeded-through-props");

      const saved = yield* stack
        .deploy(random)
        .pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
        );
      expect(Redacted.value(saved.text)).toBe("seeded-through-props");

      yield* stack.destroy();
    }),
  );

  test.provider("does not generate when a required Config.Redacted is initially missing", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const random = Random("required-missing-key", {
        initial: Config.Redacted("MIGRATED_RANDOM_SECRET"),
      });
      const missing = yield* Effect.result(
        stack
          .deploy(random)
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromEnv({ env: {} }),
            ),
          ),
      );
      expect(missing._tag).toBe("Failure");

      const adopted = yield* stack
        .deploy(random)
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { MIGRATED_RANDOM_SECRET: "recovered-seed" } }),
          ),
        );
      expect(Redacted.value(adopted.text)).toBe("recovered-seed");

      yield* stack.destroy();
    }),
  );

  test.provider("supports required seeds through the yielded Resource constructor", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const make = yield* Random;
        return yield* make("yielded-config-stable", {
          initial: Config.Redacted("MIGRATED_RANDOM_SECRET"),
        });
      });
      const first = yield* stack
        .deploy(program)
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { MIGRATED_RANDOM_SECRET: "yielded-key" } }),
          ),
        );
      expect(Redacted.value(first.text)).toBe("yielded-key");

      const plan = yield* stack
        .plan(program)
        .pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
        );
      expect(plan.resources["yielded-config-stable"]?.action).toBe("noop");

      const next = yield* stack
        .deploy(program)
        .pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
        );
      expect(Redacted.value(next.text)).toBe("yielded-key");

      yield* stack.destroy();
    }),
  );

  test.provider("generates when the optional Config.Redacted seed is missing", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const input = Random("optional-missing-key", {
        bytes: 10,
        initial: Config.option(Config.Redacted("MIGRATED_RANDOM_SECRET")),
      });
      const output = yield* stack
        .deploy(input)
        .pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
        );
      expect(Redacted.value(output.text)).toMatch(/^[0-9a-f]{20}$/);

      yield* stack.destroy();
    }),
  );

  test.provider("generates a value if the optional initial is absent", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(Random("no-seed", { bytes: 12, initial: Option.none() }));

      expect(Redacted.value(output.text)).toMatch(/^[0-9a-f]{24}$/);
      const subsequent = yield* stack.deploy(
        Random("no-seed", { initial: Redacted.make("too-late-to-seed") }),
      );
      expect(Redacted.value(subsequent.text)).toBe(Redacted.value(output.text));

      yield* stack.destroy();
    }),
  );

  test.provider("accepts an empty redacted value without generating a new one", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const output = yield* stack.deploy(Random("empty-seed", { initial: Redacted.make("") }));
      expect(Redacted.value(output.text)).toBe("");

      yield* stack.destroy();
    }),
  );

  test.provider("does not reveal the migrated value in serialized plans", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const secret = "SECRET_VALUE_MUST_NOT_APPEAR_IN_PLAN_2951";
      const program = Random("redacted-plan", { initial: Redacted.make(secret) });
      const plan = yield* stack.plan(program);

      expect(JSON.stringify(plan)).not.toContain(secret);
      expect(JSON.stringify(plan)).toContain("<redacted>");
      const node = plan.resources["redacted-plan"];
      const formatted = formatYamlLines(node && "props" in node ? node.props : {}).join("\n");
      expect(formatted).not.toContain(secret);

      const optionalPlan = yield* stack
        .plan(
          Random("redacted-plan-optional", {
            initial: Config.option(Config.Redacted("MIGRATED_RANDOM_SECRET")),
          }),
        )
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { MIGRATED_RANDOM_SECRET: secret } }),
          ),
        );
      expect(JSON.stringify(optionalPlan)).not.toContain(secret);
      const optionalNode = optionalPlan.resources["redacted-plan-optional"];
      const optionalFormatted = formatYamlLines(
        optionalNode && "props" in optionalNode ? optionalNode.props : {},
      ).join("\n");
      expect(optionalFormatted).not.toContain(secret);

      yield* stack.destroy();
    }),
  );

  test.provider("keeps makeRandom and generated hex behavior unchanged", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = yield* stack.deploy(makeRandom("backwards-compatible", { bytes: 16 }));
      expect(Redacted.value(key)).toMatch(/^[0-9a-f]{32}$/);

      const imported = yield* stack
        .deploy(
          makeRandom("make-random-imported", { initial: Config.Redacted("IMPORTED_RANDOM_VALUE") }),
        )
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { IMPORTED_RANDOM_VALUE: "make-random-existing" } }),
          ),
        );
      expect(Redacted.value(imported)).toBe("make-random-existing");

      yield* stack.destroy();
    }),
  );

  test.provider("fails closed on malformed persisted secrets instead of rotating", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fqn = "corrupted-saved-secret";
      const original = yield* stack.deploy(
        Random(fqn, { initial: Redacted.make("irreplaceable-data-key") }),
      );
      expect(Redacted.value(original.text)).toBe("irreplaceable-data-key");

      const state = yield* yield* State;
      const context = yield* Stack;
      const saved = yield* state.get({
        stack: context.name,
        stage: context.stage,
        fqn,
      });
      expect(saved?.status).toBe("created");
      if (!isResourceState(saved)) return yield* Effect.die("No original resource state row");

      for (const attr of [{ text: "not-redacted" }, { text: Redacted.make(42) }, {}, undefined]) {
        const corrupted = { ...saved, attr: attr ?? {} };
        // Simulate a physically damaged persisted row: the runtime record
        // may omit a property the typed CreatedResourceState contract requires.
        if (attr === undefined) Reflect.deleteProperty(corrupted, "attr");
        yield* state.set({
          stack: context.name,
          stage: context.stage,
          fqn,
          value: corrupted,
        });
        const result = yield* Effect.result(
          stack.plan(Random(fqn, { initial: Redacted.make("must-not-replace") })),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("InvalidRandomState");
          expect(JSON.stringify(result.failure)).not.toContain("irreplaceable-data-key");
        }
      }

      yield* state.set({
        stack: context.name,
        stage: context.stage,
        fqn,
        value: saved,
      });
      const stable = yield* stack.deploy(Random(fqn));
      expect(Redacted.value(stable.text)).toBe("irreplaceable-data-key");
      yield* stack.destroy();
    }),
  );

  test.provider("list returns [] for the non-listable random secret", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Random("list-secret");
        }),
      );

      const provider = yield* Provider.findProvider(Random);
      expect(yield* provider.list()).toEqual([]);

      yield* stack.destroy();
    }),
  );
});
