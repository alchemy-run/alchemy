import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Plan from "@/Plan.ts";
import * as Provider from "@/Provider.ts";
import { Resource } from "@/Resource.ts";
import * as State from "@/State/index.ts";

interface Inheriting extends Resource<
  "Test.Inheriting",
  { label: string },
  { value: string },
  { value: string }
> {}
const Inheriting = Resource<Inheriting>("Test.Inheriting");
const providers = Provider.succeed(Inheriting, {
  nativeBindingInheritance: true,
  list: () => Effect.succeed([]),
  reconcile: ({ bindings, output }) => {
    const binding = bindings[0];
    if (binding === undefined) return Effect.die(new Error("Missing fixture binding"));
    return Effect.succeed({
      value:
        binding.valueSource === "inherit" && output !== undefined
          ? output.value
          : binding.data.value,
    });
  },
  delete: () => Effect.void,
});
const { test } = Test.make({ providers, state: State.inMemoryState(), sidecar: false });
const program = (label: string, inherit: boolean) =>
  Effect.gen(function* () {
    const resource = yield* Inheriting("Subject", { label });
    yield* resource.bind(
      "Value",
      { value: inherit ? "native-inherit-marker" : "original" },
      { valueSource: inherit ? "inherit" : "value" },
    );
    const dependent = yield* Inheriting("Dependent", { label: resource.value });
    yield* dependent.bind("Value", { value: "dependent" });
    return resource.value;
  });

describe("binding provenance lifecycle", { tags: ["unit"] }, () => {
  test.provider("survives native apply, persistence, replan and deletion", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      expect(yield* stack.deploy(program("one", false))).toBe("original");
      const unchanged = yield* stack.plan(program("one", true));
      expect(Plan.describePlan(unchanged).resources.every((row) => row.action === "noop")).toBe(
        true,
      );
      expect(
        Plan.describePlan(unchanged).resources.find((row) => row.fqn === "Subject")?.bindings[0]
          ?.action,
      ).toBe("noop");
      expect(yield* stack.deploy(program("two", true))).toBe("original");
      const stored = yield* Effect.gen(function* () {
        const state = yield* yield* State.State;
        return yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Subject" });
      }).pipe(Effect.provide(stack.state));
      if (stored === undefined || !("bindings" in stored))
        throw new Error("Missing persisted resource bindings");
      expect(stored.bindings[0]?.valueSource).toBe("inherit");
      const replanned = yield* stack.plan(program("two", true));
      expect(
        Plan.describePlan(replanned).resources.find((row) => row.fqn === "Subject")?.bindings[0]
          ?.valueSource,
      ).toBe("inherit");
      const removal = yield* stack.plan(Effect.void);
      expect(
        Plan.describePlan(removal).resources.find(
          (row) => row.action === "delete" && row.fqn === "Subject",
        )?.bindings[0]?.valueSource,
      ).toBe("inherit");
      yield* stack.destroy();
    }),
  );
});
