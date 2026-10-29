import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Namespace from "@/Namespace";
import * as Plan from "@/Plan";
import { renamedFrom } from "@/Rename";
import { DuplicateLogicalIdError } from "@/Resource";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { InMemoryService, inMemoryState, State } from "@/State";
import { Bucket, Queue, TestLayers } from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

describe("logical ids", { tags: ["unit", "local"] }, () => {
  test.provider("a second type under the same logical id dies", (stack) =>
    Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        yield* Bucket("Thing", { name: "topic" });
        yield* Queue("Thing", { name: "queue" });
        return {};
      }).pipe(stack.deploy, Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const defects = exit.cause.reasons.flatMap((reason) =>
          reason._tag === "Die" && reason.defect instanceof DuplicateLogicalIdError
            ? [reason.defect]
            : [],
        );
        const duplicate = defects.find((defect) => defect._tag === "DuplicateLogicalIdError");
        expect(duplicate?.fqn).toEqual("Thing");
        expect(duplicate?.existingType).toEqual("Test.Bucket");
        expect(duplicate?.conflictingType).toEqual("Test.Queue");
        expect(duplicate?.message).toContain("'Thing'");
        expect(duplicate?.message).toContain("'Test.Bucket'");
        expect(duplicate?.message).toContain("'Test.Queue'");
      }
    }),
  );

  test.provider("an id whose state file another id could share dies", (stack) =>
    Effect.gen(function* () {
      // `My/Resource` is stored as `My__Resource.json`.
      const exit = yield* Effect.gen(function* () {
        yield* Bucket("Resource", { name: "nested" }).pipe(Namespace.push("My"));
        yield* Bucket("My__Resource", { name: "flat" });
        return {};
      }).pipe(stack.deploy, Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const invalid = exit.cause.reasons.flatMap((reason) =>
          reason._tag === "Die" &&
          Predicate.isTagged(reason.defect, "InvalidLogicalIdError") &&
          Predicate.hasProperty(reason.defect, "fqn") &&
          Predicate.hasProperty(reason.defect, "message")
            ? [{ fqn: reason.defect.fqn, message: String(reason.defect.message) }]
            : [],
        );
        expect(invalid[0]?.fqn).toEqual("My__Resource");
        expect(invalid[0]?.message).toContain("reads back as 'My/Resource'");
        expect(invalid[0]?.message).toContain('renamedFrom({ fqn: "My/Resource" })');
      }
    }),
  );

  test.provider(
    "a resource deployed under a refused id keeps its state when renamed with renamedFrom",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return { bucket: yield* Bucket("Seed", { name: "flat" }) };
          }),
        );
        // Store the row the way an earlier release did for `My__Bucket`:
        // under the file `My__Bucket.json`, which lists as `My/Bucket`.
        const state = yield* yield* State;
        const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "Seed" });
        yield* state.set({
          stack: stack.name,
          stage: stack.stage,
          fqn: "My__Bucket",
          value: { ...row!, fqn: "My__Bucket", logicalId: "My__Bucket" },
        });
        yield* state.delete({ stack: stack.name, stage: stack.stage, fqn: "Seed" });
        expect(yield* state.list({ stack: stack.name, stage: stack.stage })).toEqual(["My/Bucket"]);

        const renamed = Effect.gen(function* () {
          return {
            bucket: yield* Bucket("MyBucket", { name: "flat" }).pipe(
              renamedFrom({ fqn: "My/Bucket" }),
            ),
          };
        });
        const plan = yield* stack.plan(renamed);
        expect(Object.keys(plan.deletions)).toEqual([]);
        expect(plan.resources.MyBucket?.action).not.toEqual("create");

        const output = yield* stack.deploy(renamed);
        expect(output.bucket.bucketArn).toEqual(deployed.bucket.bucketArn);
        expect(yield* state.list({ stack: stack.name, stage: stack.stage })).toEqual(["MyBucket"]);

        yield* stack.destroy();
      }),
  );

  test.provider("an id with '_' at a segment edge deploys on local state", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        yield* Bucket("_internal", { name: "leading" });
        yield* Bucket("trailing_", { name: "trailing" });
        yield* Bucket("_child", { name: "nested" }).pipe(Namespace.push("Ns"));
        return {};
      });
      yield* stack.deploy(program);

      // Each row lists back as its own id: nothing is planned for deletion.
      const plan = yield* stack.plan(program);
      expect(Object.keys(plan.deletions)).toEqual([]);
      expect(Object.values(plan.resources).map((node) => node.action)).toEqual([
        "noop",
        "noop",
        "noop",
      ]);

      yield* stack.destroy();
    }),
  );

  test.provider("a refused id leaves nothing behind", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const exit = yield* Effect.gen(function* () {
        yield* Bucket("Fine", { name: "fine" });
        yield* Bucket("My__Resource", { name: "flat" });
        return {};
      }).pipe(stack.deploy, Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);

      // Refused while planning: the valid sibling was not created either.
      const plan = yield* stack.plan(
        Effect.gen(function* () {
          yield* Bucket("Fine", { name: "fine" });
          return {};
        }),
      );
      expect(plan.resources.Fine?.action).toEqual("create");
    }),
  );

  test(
    "a store keyed by the raw id accepts '__'",
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        yield* Bucket("My__Resource", { name: "flat" });
        yield* Bucket("Resource", { name: "nested" }).pipe(Namespace.push("My"));
        return {};
      });
      const plan = yield* program.pipe(
        // @ts-expect-error - Stack.make's typing erases R unsoundly (see plan.test.ts)
        Stack.make({ name: "raw-keys", providers: Layer.empty, state: inMemoryState() }),
        Effect.provideService(Stage, "test"),
        Effect.flatMap((spec: any) => Plan.make(spec)),
        Effect.provide(Layer.merge(TestLayers(), Layer.succeed(State, InMemoryService({})))),
      ) as unknown as Effect.Effect<Plan.Plan<unknown>>;
      expect(Object.keys(plan.resources).sort()).toEqual(["My/Resource", "My__Resource"]);
    }),
  );

  test.provider("yielding the same logical id returns the registered resource", (stack) =>
    Effect.gen(function* () {
      const output = yield* Effect.gen(function* () {
        const first = yield* Bucket("Thing", { name: "a" });
        const again = yield* Bucket("Thing", { name: "a" });
        const reference = yield* Bucket("Thing");
        return { first, again, reference };
      }).pipe(stack.deploy);

      expect(output.again).toBe(output.first);
      expect(output.reference).toBe(output.first);

      yield* stack.destroy();
    }),
  );
});
