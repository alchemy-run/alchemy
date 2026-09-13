import { describe, expect, it } from "alchemy-test";
import type { ConfigError } from "effect/Config";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Alchemy from "@/index.ts";
import { Stage } from "@/Stage.ts";
import * as State from "@/State/index.ts";
import * as Test from "@/Test/Alchemy.ts";

// These tests are compile-time assertions: they verify that the
// `Alchemy.Stack` effect permits a `ConfigError` in its body without
// forcing the user to `Effect.orDie`. See
// https://github.com/alchemy-run/alchemy/issues/479
describe("Alchemy.Stack error channel", () => {
  it("allows ConfigError in the stack body", () => {
    // A stack body that reads from `effect/Config` fails with `ConfigError`.
    // Before #479 this required `Effect.orDie`; now it type-checks directly.
    const stack = Alchemy.Stack(
      "ConfigErrorStack",
      {
        providers: Layer.empty as any,
        state: Layer.empty as any,
      },
      Effect.gen(function* () {
        const value = yield* Config.String("SOME_CONFIG");
        return { value };
      }),
    );

    // The resulting effect surfaces `ConfigError` in its error channel rather
    // than `never` — the whole point of the change.
    type ErrorOf<T> = T extends Effect.Effect<any, infer E, any> ? E : never;
    const _assertError: ErrorOf<typeof stack> extends ConfigError
      ? true
      : false = true;
    expect(_assertError).toBe(true);
  });

  it("still accepts an infallible stack body", () => {
    const stack = Alchemy.Stack(
      "InfallibleStack",
      {
        providers: Layer.empty as any,
        state: Layer.empty as any,
      },
      Effect.succeed({ value: "ok" }),
    );

    const _stackName: string = stack.stackName;
    expect(_stackName).toBe("InfallibleStack");
    expect(typeof stack).toBe("object");
  });
});

describe("Alchemy.Stack runtime metadata", () => {
  it("exposes stackName, providers, and state on a configured stack", () => {
    const providers = Layer.empty;
    const state = State.inMemoryState();
    const stack = Alchemy.Stack(
      "MetaStack",
      { providers, state },
      Effect.succeed({ value: "ok" }),
    );

    expect(stack.stackName).toBe("MetaStack");
    expect(stack.providers).toBe(providers);
    expect(stack.state).toBe(state);
  });

  it("exposes stackName on a class reference", () => {
    class NamedStack extends Alchemy.Stack<NamedStack, { value: string }>()(
      "NamedStack",
    ) {}

    expect(NamedStack.stackName).toBe("NamedStack");
  });

  it("exposes configured metadata identities on a class reference's make result", () => {
    class NamedStack extends Alchemy.Stack<NamedStack, { value: string }>()(
      "MadeStack",
    ) {}
    const providers = Layer.empty;
    const state = State.inMemoryState();
    const stack = NamedStack.make(
      { providers, state },
      Effect.succeed({ value: "ok" }),
    );

    expect(stack.stackName).toBe("MadeStack");
    expect(stack.providers).toBe(providers);
    expect(stack.state).toBe(state);
  });

  it("exposes only name metadata on the inline class reference form", () => {
    class InlineStack extends Alchemy.Stack<InlineStack>()(
      "InlineStack",
      { providers: Layer.empty, state: State.inMemoryState() },
      Effect.succeed({ value: "ok" }),
    ) {}

    expect(InlineStack.stackName).toBe("InlineStack");
    expect(InlineStack).toHaveProperty("providers", undefined);
    expect(InlineStack).toHaveProperty("state", undefined);
  });
});

describe("Test.make configured stack", () => {
  const store = State.InMemoryService();
  const configured = Alchemy.Stack(
    "TestMetadataStack",
    { providers: Layer.empty, state: Layer.succeed(State.State, store) },
    Effect.map(Stage, (stage) => ({ stage })),
  );
  const defaults = Test.make(configured);
  const explicit = Test.make({ ...configured, stage: "metadata-explicit" });

  defaults.test(
    "uses a default stage string instead of the stack reference proxy",
    Effect.gen(function* () {
      expect(yield* State.State).toBe(store);
      const output = yield* defaults.deploy(configured);
      expect(typeof output.stage).toBe("string");
      expect(output.stage).toBe(Test.defaultStage());
      const state = yield* store;
      expect(
        yield* state.getOutput({
          stack: configured.stackName,
          stage: output.stage,
        }),
      ).toEqual(output);
    }).pipe(Effect.ensuring(defaults.destroy(configured).pipe(Effect.orDie))),
  );

  explicit.test(
    "honors file-level and per-call stage overrides",
    Effect.gen(function* () {
      const output = yield* explicit.deploy(configured);
      expect(output.stage).toBe("metadata-explicit");
      const override = yield* explicit.deploy(configured, {
        stage: "metadata-call",
      });
      expect(override.stage).toBe("metadata-call");
    }).pipe(
      Effect.ensuring(
        explicit
          .destroy(configured, { stage: "metadata-call" })
          .pipe(Effect.orDie),
      ),
      Effect.ensuring(explicit.destroy(configured).pipe(Effect.orDie)),
    ),
  );
});
