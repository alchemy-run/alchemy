import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { formatYamlLines } from "@/Cli/PropertyDiff.ts";
import * as Provider from "@/Provider";
import { makeRandom, Random, RandomProvider } from "@/Random";
import { inMemoryState } from "@/State";
import { encodeState, reviveState } from "@/State/StateEncoding.ts";

const { test } = Test.make({
  providers: RandomProvider(),
  state: inMemoryState(),
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
