import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AlchemyContext } from "@/AlchemyContext.ts";
import * as Alchemy from "@/index.ts";
import { Stage } from "@/Stage";
import { localState, State } from "@/State";
import { TestLayers, TestResource } from "./test.resources.ts";

// `Test.make({ dotAlchemy })` moves the file's whole `.alchemy`, local state
// included: the harness's own store, and the stores `deploy(Stack)` and
// `destroy(Stack)` build. Both used to write to the default `.alchemy`.

const dotAlchemy = ".alchemy-test-dot-alchemy";
const harness = Test.make({ providers: TestLayers(), dotAlchemy });

/** Remove what a test may have written, in the moved and the default `.alchemy`, pass or fail. */
const cleanUp = (stack: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(dotAlchemy, { recursive: true, force: true });
    yield* fs.remove(path.resolve(".alchemy", "state", stack), { recursive: true, force: true });
  }).pipe(Effect.orDie);

const DotAlchemyStack = Alchemy.Stack(
  "DotAlchemyStack",
  { providers: TestLayers(), state: localState() },
  Effect.gen(function* () {
    yield* TestResource("A", { string: "a" });
    return { stage: yield* Stage, dotAlchemy: (yield* AlchemyContext).dotAlchemy };
  }),
);

describe.sequential("Test.make dotAlchemy", { tags: ["unit", "local"] }, () => {
  harness.test(
    "deploy(Stack) and destroy(Stack) keep local state under dotAlchemy",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const moved = path.resolve(dotAlchemy, "state", "DotAlchemyStack");
      const fallback = path.resolve(".alchemy", "state", "DotAlchemyStack");

      const deployed = yield* harness.deploy(DotAlchemyStack);
      expect(deployed.dotAlchemy).toBe(path.resolve(dotAlchemy));
      expect(yield* fs.exists(path.join(moved, deployed.stage))).toBe(true);
      expect(yield* fs.exists(fallback)).toBe(false);

      yield* harness.destroy(DotAlchemyStack);
      expect(yield* fs.exists(fallback)).toBe(false);
    }).pipe(Effect.ensuring(cleanUp("DotAlchemyStack"))),
  );

  harness.test(
    "the harness's own store writes under dotAlchemy",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* yield* State;

      yield* state.setOutput({ stack: "DotAlchemyStore", stage: "test", value: { ok: true } });
      const moved = yield* fs.exists(path.resolve(dotAlchemy, "state", "DotAlchemyStore"));
      const fallback = yield* fs.exists(path.resolve(".alchemy", "state", "DotAlchemyStore"));

      yield* state.deleteStack({ stack: "DotAlchemyStore" });
      expect({ moved, fallback }).toEqual({ moved: true, fallback: false });
    }).pipe(Effect.ensuring(cleanUp("DotAlchemyStore"))),
  );
});
