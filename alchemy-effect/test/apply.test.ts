import * as Effect from "effect/Effect";

import { apply } from "@/apply";
import { destroy } from "@/destroy";
import * as Output from "@/output";
import {
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  State,
} from "@/state";
import { test } from "@/test";
import { expect, describe } from "@effect/vitest";
import {
  type TestResourceProps,
  type StaticStablesResourceProps,
  InMemoryTestLayers,
  TestLayers,
  TestResource,
  TestResourceHooks,
  StaticStablesResource,
  StaticStablesResourceHooks,
} from "./test.resources.ts";
import { Data, Layer } from "effect";
import { App } from "@/app";
import { CannotReplacePartiallyReplacedResource } from "@/plan";

const testStack = "test";
const testStage = "test";

const getState = Effect.fn(function* <S = ResourceState>(resourceId: string) {
  const state = yield* State;
  return (yield* state.get({
    stack: testStack,
    stage: testStage,
    resourceId,
  })) as S;
});
const listState = Effect.fn(function* () {
  const state = yield* State;
  return yield* state.list({ stack: testStack, stage: testStage });
});

const mockApp = App.of({ name: testStack, stage: testStage, config: {} });

export class ResourceFailure extends Data.TaggedError("ResourceFailure")<{
  message: string;
}> {
  constructor() {
    super({ message: `Failed to create` });
  }
}

const MockLayers = () =>
  Layer.mergeAll(InMemoryTestLayers(), Layer.succeed(App, mockApp));

const fail = <Err, Req>(
  test: Effect.Effect<void, Err, Req>,
  hooks?: {
    create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    delete?: (id: string) => Effect.Effect<void, any>;
  },
): Effect.Effect<void, Err, Req | State> =>
  test.pipe(
    Effect.provide(
      Layer.succeed(
        TestResourceHooks,
        hooks ?? {
          create: () => Effect.fail(new ResourceFailure()),
          update: () => Effect.fail(new ResourceFailure()),
          delete: () => Effect.fail(new ResourceFailure()),
        },
      ),
    ),
    // @ts-expect-error
    Effect.catchTag("ResourceFailure", () => Effect.succeed(true)),
  );

// Helper to fail on specific resource IDs
const failOn = (
  resourceId: string,
  hook: "create" | "update" | "delete",
): {
  create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  delete?: (id: string) => Effect.Effect<void, any>;
} => ({
  [hook]: (id: string) =>
    id === resourceId
      ? Effect.fail(new ResourceFailure())
      : Effect.succeed(undefined),
});

// Helper to fail on multiple resource IDs for different hooks
const failOnMultiple = (
  failures: Array<{ id: string; hook: "create" | "update" | "delete" }>,
): {
  create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  delete?: (id: string) => Effect.Effect<void, any>;
} => {
  const createFailures = failures
    .filter((f) => f.hook === "create")
    .map((f) => f.id);
  const updateFailures = failures
    .filter((f) => f.hook === "update")
    .map((f) => f.id);
  const deleteFailures = failures
    .filter((f) => f.hook === "delete")
    .map((f) => f.id);

  return {
    create: (id: string) =>
      createFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
    update: (id: string) =>
      updateFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
    delete: (id: string) =>
      deleteFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
  };
};

describe("basic operations", () => {
  test(
    "should create, update, and delete resources",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "test-string",
        }) {}

        const stack = yield* apply(A);
        expect(stack.A.string).toEqual("test-string");
      }

      {
        class A extends TestResource("A", {
          string: "test-string-new",
        }) {}

        const stack = yield* apply(A);
        expect(stack.A.string).toEqual("test-string-new");
      }

      yield* destroy();

      const state = yield* State;

      expect(yield* getState("A")).toBeUndefined();
      expect(yield* listState()).toEqual([]);
    }).pipe(Effect.provide(TestLayers)),
  );

  test(
    "should resolve output properties",
    Effect.gen(function* () {
      class A extends TestResource("A", {
        string: "test-string",
        stringArray: ["test-string-array"],
      }) {}
      {
        class B extends TestResource("B", {
          string: Output.of(A).string,
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.string).toEqual("test-string");
      }

      {
        class B extends TestResource("B", {
          string: Output.of(A).string.apply((string) => string.toUpperCase()),
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.string).toEqual("TEST-STRING");
      }

      {
        class B extends TestResource("B", {
          string: Output.of(A).string.effect((string) =>
            Effect.succeed(string.toUpperCase() + "-NEW"),
          ),
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.string).toEqual("TEST-STRING-NEW");
      }

      {
        class B extends TestResource("B", {
          string: Output.of(A)
            .string.apply((string) => string.toUpperCase())
            .apply((string) => string + "-CALL-EXPR"),
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.string).toEqual("TEST-STRING-CALL-EXPR");
      }

      {
        class B extends TestResource("B", {
          stringArray: Output.of(A).stringArray,
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.stringArray).toEqual(["test-string-array"]);
      }

      {
        class B extends TestResource("B", {
          string: Output.of(A).stringArray[0],
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.string).toEqual("test-string-array");
      }

      {
        class B extends TestResource("B", {
          string: Output.of(A).stringArray[0].apply((string) =>
            string.toUpperCase(),
          ),
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.string).toEqual("TEST-STRING-ARRAY");
      }

      {
        class B extends TestResource("B", {
          stringArray: Output.of(A).stringArray.apply((string) =>
            string.map((string) => string.toUpperCase()),
          ),
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.stringArray).toEqual(["TEST-STRING-ARRAY"]);
      }

      {
        class B extends TestResource("B", {
          stringArray: Output.of(A).stringArray.apply((stringArray) =>
            stringArray.flatMap((string) => [string, string]),
          ),
        }) {}

        const stack = yield* apply(B);
        expect(stack.B.stringArray).toEqual([
          "test-string-array",
          "test-string-array",
        ]);
      }
    }).pipe(Effect.provide(TestLayers)),
  );
});

describe("from created state", () => {
  test(
    "noop when props unchanged",
    Effect.gen(function* () {
      class A extends TestResource("A", {
        string: "test-string",
      }) {}
      yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");

      // Re-apply with same props - should be noop
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.string).toEqual("test-string");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "replace when props trigger replacement",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          replaceString: "original",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      // Change props that trigger replacement
      class A extends TestResource("A", {
        replaceString: "new",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("new");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from updated state", () => {
  test(
    "noop when props unchanged",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "test-string",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        // Update to get to updated state
        class A extends TestResource("A", {
          string: "test-string-changed",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("updated");
      }
      // Re-apply with same props - should be noop
      class A extends TestResource("A", {
        string: "test-string-changed",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(stack.A.string).toEqual("test-string-changed");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "replace when props trigger replacement",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "test-string",
          replaceString: "original",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        // Update to get to updated state
        class A extends TestResource("A", {
          string: "test-string-changed",
          replaceString: "original",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("updated");
      }
      // Change props that trigger replacement
      class A extends TestResource("A", {
        string: "test-string-changed",
        replaceString: "new",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("new");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from creating state", () => {
  test(
    "continue creating when props unchanged",
    Effect.gen(function* () {
      class A extends TestResource("A", {
        string: "test-string",
      }) {}
      yield* fail(apply(A));
      expect((yield* getState("A"))?.status).toEqual("creating");
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.string).toEqual("test-string");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "continue creating when props have updatable changes",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "test-string",
        }) {}
        yield* fail(apply(A));
        expect((yield* getState("A"))?.status).toEqual("creating");
      }
      class A extends TestResource("A", {
        string: "test-string-changed",
      }) {}
      const stack = yield* apply(A);
      expect(stack.A.string).toEqual("test-string-changed");
      expect((yield* getState("A"))?.status).toEqual("created");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "replace when props trigger replacement",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          replaceString: "test-string",
        }) {}
        yield* fail(apply(A));
        expect((yield* getState("A"))?.status).toEqual("creating");
      }
      class A extends TestResource("A", {
        replaceString: "test-string-changed",
      }) {}
      const stack = yield* apply(A);
      expect(stack.A.replaceString).toEqual("test-string-changed");
      expect((yield* getState("A"))?.status).toEqual("created");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from updating state", () => {
  test(
    "continue updating when props unchanged",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "test-string",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        class A extends TestResource("A", {
          string: "test-string-changed",
        }) {}
        yield* fail(apply(A), {
          update: () => Effect.fail(new ResourceFailure()),
        });
        expect((yield* getState("A"))?.status).toEqual("updating");
      }
      class A extends TestResource("A", {
        string: "test-string-changed",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(stack.A.string).toEqual("test-string-changed");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "continue updating when props have updatable changes",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "test-string",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        class A extends TestResource("A", {
          string: "test-string-changed",
        }) {}
        yield* fail(apply(A), {
          update: () => Effect.fail(new ResourceFailure()),
        });
        expect((yield* getState("A"))?.status).toEqual("updating");
      }
      class A extends TestResource("A", {
        string: "test-string-changed-again",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(stack.A.string).toEqual("test-string-changed-again");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "replace when props trigger replacement",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "test-string",
          replaceString: "original",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        class A extends TestResource("A", {
          string: "test-string-changed",
          replaceString: "original",
        }) {}
        yield* fail(apply(A), {
          update: () => Effect.fail(new ResourceFailure()),
        });
        expect((yield* getState("A"))?.status).toEqual("updating");
      }
      class A extends TestResource("A", {
        string: "test-string-changed",
        replaceString: "changed",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("changed");
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from replacing state", () => {
  test(
    "continue replacement when props unchanged",
    Effect.gen(function* () {
      {
        // 1. Create initial resource
        class A extends TestResource("A", {
          replaceString: "original",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        // 2. Trigger replacement but fail during create of replacement
        class A extends TestResource("A", {
          replaceString: "new",
        }) {}
        yield* fail(apply(A), {
          create: () => Effect.fail(new ResourceFailure()),
        });
        const state = yield* getState<ReplacingResourceState>("A");
        expect(state?.status).toEqual("replacing");
        expect(state?.old?.status).toEqual("created");
      }
      // 3. Re-apply with same props - should continue replacement
      class A extends TestResource("A", {
        replaceString: "new",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "continue replacement when props have updatable changes",
    Effect.gen(function* () {
      {
        // 1. Create initial resource
        class A extends TestResource("A", {
          replaceString: "original",
          string: "initial",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        // 2. Trigger replacement but fail during create
        class A extends TestResource("A", {
          replaceString: "new",
          string: "initial",
        }) {}
        yield* fail(apply(A), {
          create: () => Effect.fail(new ResourceFailure()),
        });
        expect((yield* getState("A"))?.status).toEqual("replacing");
      }
      // 3. Re-apply with changed props (updatable) - should continue replacement with new props
      class A extends TestResource("A", {
        replaceString: "new",
        string: "changed",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("new");
      expect(stack.A.string).toEqual("changed");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "error when props trigger another replacement",
    Effect.gen(function* () {
      {
        // 1. Create initial resource
        class A extends TestResource("A", {
          replaceString: "original",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        // 2. Trigger replacement but fail during create
        class A extends TestResource("A", {
          replaceString: "new",
        }) {}
        yield* fail(apply(A), {
          create: () => Effect.fail(new ResourceFailure()),
        });
        expect((yield* getState("A"))?.status).toEqual("replacing");
      }
      // 3. Try to replace again with another replacement - should fail
      class A extends TestResource("A", {
        replaceString: "another-replacement",
      }) {}
      const result = yield* apply(A).pipe(Effect.either);
      expect(result._tag).toEqual("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(
          CannotReplacePartiallyReplacedResource,
        );
      }
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from replaced state", () => {
  test(
    "continue cleanup when props unchanged",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          replaceString: "test-string",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      class A extends TestResource("A", {
        replaceString: "test-string-changed",
      }) {}
      yield* fail(apply(A), {
        delete: () => Effect.fail(new ResourceFailure()),
      });
      const AState = yield* getState<ReplacedResourceState>("A");
      expect(AState?.status).toEqual("replaced");
      expect(AState?.old).toMatchObject({
        status: "created",
        props: {
          replaceString: "test-string",
        },
      });
      yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "update replacement then cleanup when props have updatable changes",
    Effect.gen(function* () {
      {
        // 1. Create initial resource
        class A extends TestResource("A", {
          replaceString: "original",
          string: "initial",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        // 2. Trigger replacement and fail during delete of old resource
        class A extends TestResource("A", {
          replaceString: "new",
          string: "initial",
        }) {}
        yield* fail(apply(A), {
          delete: () => Effect.fail(new ResourceFailure()),
        });
        const state = yield* getState<ReplacedResourceState>("A");
        expect(state?.status).toEqual("replaced");
        expect(state?.old?.status).toEqual("created");
      }
      // 3. Change props again (updatable change) - should update the replacement then cleanup
      class A extends TestResource("A", {
        replaceString: "new",
        string: "changed",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("new");
      expect(stack.A.string).toEqual("changed");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "error when props trigger another replacement",
    Effect.gen(function* () {
      {
        // 1. Create initial resource
        class A extends TestResource("A", {
          replaceString: "original",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        // 2. Trigger replacement and fail during delete of old resource
        class A extends TestResource("A", {
          replaceString: "new",
        }) {}
        yield* fail(apply(A), {
          delete: () => Effect.fail(new ResourceFailure()),
        });
        expect((yield* getState("A"))?.status).toEqual("replaced");
      }
      // 3. Try to replace again - should fail
      class A extends TestResource("A", {
        replaceString: "another-replacement",
      }) {}
      const result = yield* apply(A).pipe(Effect.either);
      expect(result._tag).toEqual("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(
          CannotReplacePartiallyReplacedResource,
        );
      }
    }).pipe(Effect.provide(MockLayers())),
  );
});

describe("from deleting state", () => {
  test(
    "create when props unchanged or have updatable changes",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "test-string",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        class A extends TestResource("A", {
          string: "test-string",
        }) {}
        yield* fail(destroy(), {
          delete: () => Effect.fail(new ResourceFailure()),
        });
        expect((yield* getState("A"))?.status).toEqual("deleting");
      }
      // Now re-apply with the same props - should create the resource again
      class A extends TestResource("A", {
        string: "test-string",
      }) {}
      const stack = yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(stack.A.string).toEqual("test-string");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "error when props trigger replacement",
    Effect.gen(function* () {
      {
        // 1. Create initial resource
        class A extends TestResource("A", {
          replaceString: "original",
        }) {}
        yield* apply(A);
        expect((yield* getState("A"))?.status).toEqual("created");
      }
      {
        // 2. Try to delete but fail
        yield* fail(destroy(), {
          delete: () => Effect.fail(new ResourceFailure()),
        });
        expect((yield* getState("A"))?.status).toEqual("deleting");
      }
      // 3. Try to re-apply with props that trigger replacement - should fail
      class A extends TestResource("A", {
        replaceString: "new",
      }) {}
      const result = yield* apply(A).pipe(Effect.either);
      expect(result._tag).toEqual("Left");
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(
          CannotReplacePartiallyReplacedResource,
        );
      }
    }).pipe(Effect.provide(MockLayers())),
  );
});

// =============================================================================
// DEPENDENT RESOURCES (A -> B where B depends on Output.of(A))
// =============================================================================

describe("dependent resources (A -> B)", () => {
  describe("happy path", () => {
    test(
      "create A then B where B uses Output.of(A)",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(stack.A.string).toEqual("a-value");
        expect(stack.B.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "update A propagates to B",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          yield* apply(B);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
        }
        // Update A's string - B should update with the new value
        class A extends TestResource("A", { string: "a-value-updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.A.string).toEqual("a-value-updated");
        expect(stack.B.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "replace A, B updates to new A's output",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          yield* apply(B);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
        }
        // Replace A - B should update to point to new A's output
        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.A.string).toEqual("a-value-new");
        expect(stack.B.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "delete both resources (B deleted first, then A)",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        yield* apply(B);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* listState()).toEqual([]);
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("failures during expandAndPivot", () => {
    test(
      "A create fails, B never starts - recovery creates both",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        // A fails to create - B should never start
        yield* fail(apply(B), failOn("A", "create"));

        expect((yield* getState("A"))?.status).toEqual("creating");
        expect(yield* getState("B")).toBeUndefined();

        // Recovery: re-apply should create both
        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(stack.A.string).toEqual("a-value");
        expect(stack.B.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, B create fails - recovery creates B",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        // A succeeds, B fails to create
        yield* fail(apply(B), failOn("B", "create"));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");

        // Recovery: re-apply should noop A and create B
        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(stack.B.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A update fails - recovery updates both",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          yield* apply(B);
        }

        class A extends TestResource("A", { string: "a-value-updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        // A fails to update - B should not start updating
        yield* fail(apply(B), failOn("A", "update"));

        expect((yield* getState("A"))?.status).toEqual("updating");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Recovery: re-apply should update both
        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.A.string).toEqual("a-value-updated");
        expect(stack.B.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A updates, B update fails - recovery updates B",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          yield* apply(B);
        }

        class A extends TestResource("A", { string: "a-value-updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        // A succeeds, B fails to update
        yield* fail(apply(B), failOn("B", "update"));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updating");

        // Recovery: re-apply should noop A and update B
        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.B.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replacement fails - recovery replaces A and updates B",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          yield* apply(B);
        }

        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        // A replacement fails (during create of new A) - B should not start
        yield* fail(apply(B), failOn("A", "create"));

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
          "replacing",
        );
        expect((yield* getState("B"))?.status).toEqual("created");

        // Recovery: re-apply should complete A replacement and update B
        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.A.string).toEqual("a-value-new");
        expect(stack.B.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replaced, B update fails - recovery updates B then cleans up",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          yield* apply(B);
        }

        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        // A replacement succeeds, B fails to update
        yield* fail(apply(B), failOn("B", "update"));

        // A should be in replaced state (new A created, old A pending cleanup)
        // B should be in updating state
        const aState = yield* getState<ReplacedResourceState>("A");
        expect(aState?.status).toEqual("replaced");
        expect((yield* getState("B"))?.status).toEqual("updating");

        // Recovery: re-apply should update B and clean up old A
        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.B.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("failures during collectGarbage", () => {
    test(
      "A replaced, B updated, old A delete fails - recovery cleans up",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          yield* apply(B);
        }

        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        // A replacement and B update succeed, but old A delete fails
        yield* fail(apply(B), failOn("A", "delete"));

        // A should be in replaced state (delete of old A failed)
        // B should have been updated successfully
        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updated");

        // Recovery: re-apply should clean up old A
        const stack = yield* apply(B);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.A.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "orphan B delete fails - recovery deletes B then A",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        yield* apply(B);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Orphan deletion: B delete fails
        yield* fail(destroy(), failOn("B", "delete"));

        // B should be in deleting state, A should still be created (waiting for B)
        expect((yield* getState("B"))?.status).toEqual("deleting");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery: re-apply destroy should delete B then A
        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "orphan A delete fails after B deleted - recovery deletes A",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}

        yield* apply(B);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Orphan deletion: B succeeds, A fails
        yield* fail(destroy(), failOn("A", "delete"));

        // B should be deleted, A should be in deleting state
        expect(yield* getState("B")).toBeUndefined();
        expect((yield* getState("A"))?.status).toEqual("deleting");

        // Recovery: re-apply destroy should delete A
        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});

// =============================================================================
// THREE-LEVEL DEPENDENCY CHAIN (A -> B -> C where C depends on B, B depends on A)
// =============================================================================

describe("three-level dependency chain (A -> B -> C)", () => {
  describe("happy path", () => {
    test(
      "create A then B then C",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        const stack = yield* apply(C);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect(stack.A.string).toEqual("a-value");
        expect(stack.B.string).toEqual("a-value");
        expect(stack.C.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "update A propagates through B to C",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", { string: "a-value-updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        const stack = yield* apply(C);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "replace A propagates through B to C",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        const stack = yield* apply(C);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "delete all three (C first, then B, then A)",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* apply(C);
        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        expect(yield* listState()).toEqual([]);
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("creation failures", () => {
    test(
      "A create fails - B and C never start",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("A", "create"));

        expect((yield* getState("A"))?.status).toEqual("creating");
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect(stack.C.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, B create fails - C never starts",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("B", "create"));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");
        expect(yield* getState("C")).toBeUndefined();

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect(stack.C.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A and B create, C create fails",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("C", "create"));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("creating");

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect(stack.C.string).toEqual("a-value");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("update failures", () => {
    test(
      "A update fails - B and C remain stable",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", { string: "a-value-updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("A", "update"));

        expect((yield* getState("A"))?.status).toEqual("updating");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A updates, B update fails - C remains stable",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", { string: "a-value-updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("B", "update"));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updating");
        expect((yield* getState("C"))?.status).toEqual("created");

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A and B update, C update fails",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", { string: "a-value-updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("C", "update"));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updating");

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-updated");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("replace cascade failures", () => {
    test(
      "A replace fails - B and C remain stable",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("A", "create"));

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
          "replacing",
        );
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replaced, B update fails - C remains stable",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("B", "update"));

        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updating");
        expect((yield* getState("C"))?.status).toEqual("created");

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replaced, B updated, C update fails",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("C", "update"));

        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updating");

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A replaced, B and C updated, old A delete fails - recovery cleans up",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", {
            string: "a-value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(B).string }) {}
          yield* apply(C);
        }

        class A extends TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* fail(apply(C), failOn("A", "delete"));

        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
          "replaced",
        );
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");

        // Recovery
        const stack = yield* apply(C);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(stack.C.string).toEqual("a-value-new");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("delete order failures", () => {
    test(
      "C delete fails - A and B waiting",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* apply(C);
        yield* fail(destroy(), failOn("C", "delete"));

        expect((yield* getState("C"))?.status).toEqual("deleting");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "C deleted, B delete fails - A waiting",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* apply(C);
        yield* fail(destroy(), failOn("B", "delete"));

        expect(yield* getState("C")).toBeUndefined();
        expect((yield* getState("B"))?.status).toEqual("deleting");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "C and B deleted, A delete fails",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}

        yield* apply(C);
        yield* fail(destroy(), failOn("A", "delete"));

        expect(yield* getState("C")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect((yield* getState("A"))?.status).toEqual("deleting");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});

// =============================================================================
// DIAMOND DEPENDENCIES (D depends on B and C, both depend on A)
//     A
//    / \
//   B   C
//    \ /
//     D
// =============================================================================

describe("diamond dependencies (A -> B,C -> D)", () => {
  describe("happy path", () => {
    test(
      "create all four resources",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        const stack = yield* apply(D);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(stack.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "update A propagates to B, C, and D",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(A).string }) {}
          class D extends TestResource("D", {
            string: Output.all(Output.of(B).string, Output.of(C).string).apply(
              ([b, c]) => `${b}-${c}`,
            ),
          }) {}
          yield* apply(D);
        }

        class A extends TestResource("A", { string: "updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        const stack = yield* apply(D);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("updated");
        expect(stack.D.string).toEqual("updated-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "delete all (D first, then B and C, then A)",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* apply(D);
        yield* destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        expect(yield* getState("D")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("creation failures", () => {
    test(
      "A create fails - B, C, D never start",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* fail(apply(D), failOn("A", "create"));

        expect((yield* getState("A"))?.status).toEqual("creating");
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        expect(yield* getState("D")).toBeUndefined();

        // Recovery
        const stack = yield* apply(D);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(stack.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, B create fails - C may create, D stuck",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* fail(apply(D), failOn("B", "create"));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");
        // C might have been created since it doesn't depend on B
        const cState = yield* getState("C");
        expect(cState === undefined || cState?.status === "created").toBe(true);
        expect(yield* getState("D")).toBeUndefined();

        // Recovery
        const stack = yield* apply(D);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(stack.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, C create fails - B may create, D stuck",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* fail(apply(D), failOn("C", "create"));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("creating");
        // B might have been created since it doesn't depend on C
        const bState = yield* getState("B");
        expect(bState === undefined || bState?.status === "created").toBe(true);
        expect(yield* getState("D")).toBeUndefined();

        // Recovery
        const stack = yield* apply(D);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(stack.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A, B, C create - D create fails",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* fail(apply(D), failOn("D", "create"));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("creating");

        // Recovery
        const stack = yield* apply(D);
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(stack.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "both B and C fail to create - D stuck",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* fail(
          apply(D),
          failOnMultiple([
            { id: "B", hook: "create" },
            { id: "C", hook: "create" },
          ]),
        );

        expect((yield* getState("A"))?.status).toEqual("created");
        // effect terminates eagerly, so it's possible that B or C to run first and block C from running
        const BState = yield* getState("B");
        const CState = yield* getState("C");
        expect(BState?.status).toBeOneOf(["creating", undefined]);
        expect(CState?.status).toBeOneOf(["creating", undefined]);
        // at leasst one of B or C should have been created
        expect(BState?.status ?? CState?.status).toEqual("creating");

        expect(yield* getState("D")).toBeUndefined();

        // Recovery
        const stack = yield* apply(D);
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");
        expect(stack.D.string).toEqual("a-value-a-value");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("update failures", () => {
    test(
      "A update fails - B, C, D remain stable",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(A).string }) {}
          class D extends TestResource("D", {
            string: Output.all(Output.of(B).string, Output.of(C).string).apply(
              ([b, c]) => `${b}-${c}`,
            ),
          }) {}
          yield* apply(D);
        }

        class A extends TestResource("A", { string: "updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* fail(apply(D), failOn("A", "update"));

        expect((yield* getState("A"))?.status).toEqual("updating");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("D"))?.status).toEqual("created");

        // Recovery
        const stack = yield* apply(D);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("updated");
        expect(stack.D.string).toEqual("updated-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A updates, B update fails - C may update, D stuck",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(A).string }) {}
          class D extends TestResource("D", {
            string: Output.all(Output.of(B).string, Output.of(C).string).apply(
              ([b, c]) => `${b}-${c}`,
            ),
          }) {}
          yield* apply(D);
        }

        class A extends TestResource("A", { string: "updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* fail(apply(D), failOn("B", "update"));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updating");
        // C might have been updated since it doesn't depend on B
        const cState = yield* getState("C");
        expect(
          cState?.status === "created" || cState?.status === "updated",
        ).toBe(true);
        expect((yield* getState("D"))?.status).toEqual("created");

        // Recovery
        const stack = yield* apply(D);
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("updated");
        expect(stack.D.string).toEqual("updated-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A, B, C update - D update fails",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}
          class C extends TestResource("C", { string: Output.of(A).string }) {}
          class D extends TestResource("D", {
            string: Output.all(Output.of(B).string, Output.of(C).string).apply(
              ([b, c]) => `${b}-${c}`,
            ),
          }) {}
          yield* apply(D);
        }

        class A extends TestResource("A", { string: "updated" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* fail(apply(D), failOn("D", "update"));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect((yield* getState("D"))?.status).toEqual("updating");

        // Recovery
        const stack = yield* apply(D);
        expect((yield* getState("D"))?.status).toEqual("updated");
        expect(stack.D.string).toEqual("updated-updated");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("delete failures", () => {
    test(
      "D delete fails - B, C, A waiting",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* apply(D);
        yield* fail(destroy(), failOn("D", "delete"));

        expect((yield* getState("D"))?.status).toEqual("deleting");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("C"))?.status).toEqual("created");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        expect(yield* getState("D")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "D deleted, B delete fails - C may delete, A waiting",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(A).string }) {}
        class D extends TestResource("D", {
          string: Output.all(Output.of(B).string, Output.of(C).string).apply(
            ([b, c]) => `${b}-${c}`,
          ),
        }) {}

        yield* apply(D);
        yield* fail(destroy(), failOn("B", "delete"));

        expect(yield* getState("D")).toBeUndefined();
        expect((yield* getState("B"))?.status).toEqual("deleting");
        // C may or may not be deleted depending on execution order
        const cState = yield* getState("C");
        expect(cState === undefined || cState?.status === "created").toBe(true);
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});

// =============================================================================
// INDEPENDENT RESOURCES (no dependencies between them)
// =============================================================================

describe("independent resources (A, B with no dependencies)", () => {
  describe("parallel failures", () => {
    test(
      "both A and B fail to create",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: "b-value" }) {}

        yield* fail(
          apply(A, B),
          failOnMultiple([
            { id: "A", hook: "create" },
            { id: "B", hook: "create" },
          ]),
        );

        // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
        const AState = yield* getState("A");
        const BState = yield* getState("B");
        expect(AState?.status).toBeOneOf(["creating", undefined]);
        expect(BState?.status).toBeOneOf(["creating", undefined]);
        // at least one of A or B should have been creating
        expect(AState?.status ?? BState?.status).toEqual("creating");

        // Recovery
        const stack = yield* apply(A, B);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(stack.A.string).toEqual("a-value");
        expect(stack.B.string).toEqual("b-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A creates, B fails - recovery creates B",
      Effect.gen(function* () {
        class A extends TestResource("A", { string: "a-value" }) {}
        class B extends TestResource("B", { string: "b-value" }) {}

        yield* fail(apply(A, B), failOn("B", "create"));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");

        // Recovery
        const stack = yield* apply(A, B);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(stack.B.string).toEqual("b-value");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A update fails, B update succeeds",
      Effect.gen(function* () {
        {
          class A extends TestResource("A", { string: "a-value" }) {}
          class B extends TestResource("B", { string: "b-value" }) {}
          yield* apply(A, B);
        }

        class A extends TestResource("A", { string: "a-updated" }) {}
        class B extends TestResource("B", { string: "b-updated" }) {}

        yield* fail(apply(A, B), failOn("A", "update"));

        expect((yield* getState("A"))?.status).toEqual("updating");
        // B might have been updated
        const bState = yield* getState("B");
        expect(
          bState?.status === "created" || bState?.status === "updated",
        ).toBe(true);

        // Recovery
        const stack = yield* apply(A, B);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.A.string).toEqual("a-updated");
        expect(stack.B.string).toEqual("b-updated");
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("mixed state recovery", () => {
    test(
      "A in creating, B in updating state - recovery completes both",
      Effect.gen(function* () {
        // First create B successfully
        class B extends TestResource("B", { string: "b-value" }) {}
        yield* apply(B);
        expect((yield* getState("B"))?.status).toEqual("created");

        // Now try to create A and update B - A fails
        class A extends TestResource("A", { string: "a-value" }) {}
        class B2 extends TestResource("B", { string: "b-updated" }) {}

        yield* fail(
          apply(A, B2),
          failOnMultiple([
            { id: "A", hook: "create" },
            { id: "B", hook: "update" },
          ]),
        );

        // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
        const AState = yield* getState("A");
        const BState = yield* getState("B");
        expect(AState?.status).toBeOneOf(["creating", undefined]);
        expect(BState?.status).toBeOneOf(["created", "updating"]);
        // at least one of A or B should have started their failing operation
        expect(
          AState?.status === "creating" || BState?.status === "updating",
        ).toBe(true);

        // Recovery
        const stack = yield* apply(A, B2);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(stack.A.string).toEqual("a-value");
        expect(stack.B.string).toEqual("b-updated");
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "A in replacing, B in deleting state - complex recovery",
      Effect.gen(function* () {
        // Create both
        class A extends TestResource("A", { replaceString: "original" }) {}
        class B extends TestResource("B", { string: "b-value" }) {}
        yield* apply(A, B);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Try to replace A and delete B (by not including B) - both fail
        class A2 extends TestResource("A", { replaceString: "changed" }) {}
        yield* fail(
          apply(A2),
          failOnMultiple([
            { id: "A", hook: "create" },
            { id: "B", hook: "delete" },
          ]),
        );

        // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
        const AState = yield* getState<ReplacingResourceState>("A");
        const BState = yield* getState("B");
        expect(AState?.status).toBeOneOf(["created", "replacing"]);
        expect(BState?.status).toBeOneOf(["created", "deleting"]);
        // at least one of A or B should have started their failing operation
        expect(
          AState?.status === "replacing" || BState?.status === "deleting",
        ).toBe(true);

        // Recovery - complete the replace and delete
        yield* apply(A2);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect(yield* getState("B")).toBeUndefined();
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});

// =============================================================================
// MULTIPLE RESOURCES REPLACING SIMULTANEOUSLY
// =============================================================================

describe("multiple resources replacing", () => {
  test(
    "two independent resources replace successfully",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", { replaceString: "a-original" }) {}
        class B extends TestResource("B", { replaceString: "b-original" }) {}
        yield* apply(A, B);
      }

      class A extends TestResource("A", { replaceString: "a-new" }) {}
      class B extends TestResource("B", { replaceString: "b-new" }) {}

      const stack = yield* apply(A, B);

      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("a-new");
      expect(stack.B.replaceString).toEqual("b-new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "A replace fails, B replace succeeds - recovery completes A",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", { replaceString: "a-original" }) {}
        class B extends TestResource("B", { replaceString: "b-original" }) {}
        yield* apply(A, B);
      }

      class A extends TestResource("A", { replaceString: "a-new" }) {}
      class B extends TestResource("B", { replaceString: "b-new" }) {}

      yield* fail(apply(A, B), failOn("A", "create"));

      expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
        "replacing",
      );
      // B might have been replaced
      const bState = yield* getState("B");
      expect(
        bState?.status === "created" ||
          bState?.status === "replacing" ||
          bState?.status === "replaced",
      ).toBe(true);

      // Recovery
      const stack = yield* apply(A, B);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("a-new");
      expect(stack.B.replaceString).toEqual("b-new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "both A and B replace fail - recovery completes both",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", { replaceString: "a-original" }) {}
        class B extends TestResource("B", { replaceString: "b-original" }) {}
        yield* apply(A, B);
      }

      class A extends TestResource("A", { replaceString: "a-new" }) {}
      class B extends TestResource("B", { replaceString: "b-new" }) {}

      yield* fail(
        apply(A, B),
        failOnMultiple([
          { id: "A", hook: "create" },
          { id: "B", hook: "create" },
        ]),
      );

      // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
      const AState = yield* getState<ReplacingResourceState>("A");
      const BState = yield* getState<ReplacingResourceState>("B");
      expect(AState?.status).toBeOneOf(["created", "replacing"]);
      expect(BState?.status).toBeOneOf(["created", "replacing"]);
      // at least one of A or B should have started replacing
      expect(
        AState?.status === "replacing" || BState?.status === "replacing",
      ).toBe(true);

      // Recovery
      const stack = yield* apply(A, B);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("a-new");
      expect(stack.B.replaceString).toEqual("b-new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "A replaced, B replacing - old A delete fails, B create fails - recovery completes both",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", { replaceString: "a-original" }) {}
        class B extends TestResource("B", { replaceString: "b-original" }) {}
        yield* apply(A, B);
      }

      class A extends TestResource("A", { replaceString: "a-new" }) {}
      class B extends TestResource("B", { replaceString: "b-new" }) {}

      yield* fail(
        apply(A, B),
        failOnMultiple([
          { id: "A", hook: "delete" },
          { id: "B", hook: "create" },
        ]),
      );

      // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
      // A should be replaced (new created, old pending delete) or still replacing/created if B failed first
      // B should be replacing (new not yet created) or already created if A failed first
      const AState = yield* getState<ReplacedResourceState>("A");
      const BState = yield* getState<ReplacingResourceState>("B");
      expect(AState?.status).toBeOneOf(["created", "replacing", "replaced"]);
      expect(BState?.status).toBeOneOf(["created", "replacing"]);
      // at least one of A or B should have started their failing operation
      expect(
        AState?.status === "replaced" || BState?.status === "replacing",
      ).toBe(true);

      // Recovery
      const stack = yield* apply(A, B);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("a-new");
      expect(stack.B.replaceString).toEqual("b-new");
    }).pipe(Effect.provide(MockLayers())),
  );
});

// =============================================================================
// ORPHAN CHAIN DELETION
// =============================================================================

describe("orphan chain deletion", () => {
  test(
    "three-level orphan chain deleted in correct order",
    Effect.gen(function* () {
      class A extends TestResource("A", { string: "a-value" }) {}
      class B extends TestResource("B", { string: Output.of(A).string }) {}
      class C extends TestResource("C", { string: Output.of(B).string }) {}

      yield* apply(C);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect((yield* getState("C"))?.status).toEqual("created");

      // Remove C from graph - should delete C only
      class A2 extends TestResource("A", { string: "a-value" }) {}
      class B2 extends TestResource("B", { string: Output.of(A2).string }) {}

      yield* apply(B2);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(yield* getState("C")).toBeUndefined();
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "orphan with intermediate failure recovers correctly",
    Effect.gen(function* () {
      class A extends TestResource("A", { string: "a-value" }) {}
      class B extends TestResource("B", { string: Output.of(A).string }) {}
      class C extends TestResource("C", { string: Output.of(B).string }) {}

      yield* apply(C);

      // Remove all three - C fails to delete
      yield* fail(destroy(), failOn("C", "delete"));

      expect((yield* getState("C"))?.status).toEqual("deleting");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect((yield* getState("A"))?.status).toEqual("created");

      // Recovery
      yield* destroy();
      expect(yield* getState("A")).toBeUndefined();
      expect(yield* getState("B")).toBeUndefined();
      expect(yield* getState("C")).toBeUndefined();
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "partial orphan - remove leaf, add new dependent",
    Effect.gen(function* () {
      class A extends TestResource("A", { string: "a-value" }) {}
      class B extends TestResource("B", { string: Output.of(A).string }) {}

      yield* apply(B);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");

      // Remove B, add C dependent on A
      class A2 extends TestResource("A", { string: "a-value" }) {}
      class C extends TestResource("C", { string: Output.of(A2).string }) {}

      const stack = yield* apply(C);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(yield* getState("B")).toBeUndefined();
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(stack.C.string).toEqual("a-value");
    }).pipe(Effect.provide(MockLayers())),
  );
});

// =============================================================================
// COMPLEX MIXED STATE SCENARIOS
// =============================================================================

describe("complex mixed state scenarios", () => {
  test(
    "replace upstream while creating downstream",
    Effect.gen(function* () {
      // Create A
      class A extends TestResource("A", {
        string: "a-value",
        replaceString: "original",
      }) {}
      yield* apply(A);
      expect((yield* getState("A"))?.status).toEqual("created");

      // Now add B dependent on A, and also replace A
      class A2 extends TestResource("A", {
        string: "a-value-new",
        replaceString: "changed",
      }) {}
      class B extends TestResource("B", { string: Output.of(A2).string }) {}

      const stack = yield* apply(B);

      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(stack.A.string).toEqual("a-value-new");
      expect(stack.B.string).toEqual("a-value-new");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "update upstream, create and delete in same apply",
    Effect.gen(function* () {
      // Create A and B
      class A extends TestResource("A", { string: "a-value" }) {}
      class B extends TestResource("B", { string: "b-value" }) {}
      yield* apply(A, B);

      // Update A, delete B (by not including), create C
      class A2 extends TestResource("A", { string: "a-updated" }) {}
      class C extends TestResource("C", { string: Output.of(A2).string }) {}

      const stack = yield* apply(C);

      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(yield* getState("B")).toBeUndefined();
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(stack.C.string).toEqual("a-updated");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "chain reaction: A replace triggers B update triggers C update",
    Effect.gen(function* () {
      {
        class A extends TestResource("A", {
          string: "a-value",
          replaceString: "original",
        }) {}
        class B extends TestResource("B", { string: Output.of(A).string }) {}
        class C extends TestResource("C", { string: Output.of(B).string }) {}
        yield* apply(C);
      }

      // Replace A - should cascade updates to B and C
      class A extends TestResource("A", {
        string: "a-replaced",
        replaceString: "changed",
      }) {}
      class B extends TestResource("B", { string: Output.of(A).string }) {}
      class C extends TestResource("C", { string: Output.of(B).string }) {}

      const stack = yield* apply(C);

      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("updated");
      expect((yield* getState("C"))?.status).toEqual("updated");
      expect(stack.C.string).toEqual("a-replaced");
    }).pipe(Effect.provide(MockLayers())),
  );

  test(
    "multiple failures across all operation types",
    Effect.gen(function* () {
      // Setup: A, B created; C, D will be added
      class A extends TestResource("A", {
        string: "a-value",
        replaceString: "original",
      }) {}
      class B extends TestResource("B", { string: "b-value" }) {}
      yield* apply(A, B);

      // Complex operation: A replace, B update, C create, D not included (nothing to delete)
      class A2 extends TestResource("A", {
        string: "a-replaced",
        replaceString: "changed",
      }) {}
      class B2 extends TestResource("B", { string: "b-updated" }) {}
      class C extends TestResource("C", { string: "c-value" }) {}

      // Fail on A replace (create phase) and C create
      yield* fail(
        apply(A2, B2, C),
        failOnMultiple([
          { id: "A", hook: "create" },
          { id: "C", hook: "create" },
        ]),
      );

      // effect terminates eagerly, so it's possible that A or C runs first and blocks the other from running
      const AState = yield* getState<ReplacingResourceState>("A");
      // B might have been updated
      const bState = yield* getState("B");
      expect(bState?.status === "created" || bState?.status === "updated").toBe(
        true,
      );
      const CState = yield* getState("C");
      expect(AState?.status).toBeOneOf(["created", "replacing"]);
      expect(CState?.status).toBeOneOf(["creating", undefined]);
      // at least one of A or C should have started their failing operation
      expect(
        AState?.status === "replacing" || CState?.status === "creating",
      ).toBe(true);

      // Recovery
      const stack = yield* apply(A2, B2, C);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("updated");
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(stack.A.replaceString).toEqual("changed");
      expect(stack.B.string).toEqual("b-updated");
      expect(stack.C.string).toEqual("c-value");
    }).pipe(Effect.provide(MockLayers())),
  );
});

// =============================================================================
// STATIC STABLE PROPERTIES (provider.stables defined on provider, not in diff)
// This tests the bug where diff returns undefined but downstream resources
// depend on stable properties that should be preserved
// =============================================================================

describe("static stable properties (provider.stables)", () => {
  describe("diff returns undefined with tag-only changes", () => {
    test(
      "upstream has static stables, diff returns undefined, downstream depends on stableId",
      Effect.gen(function* () {
        // Stage 1: Create A with no tags, B depends on A.stableId
        {
          class A extends StaticStablesResource("A", { string: "value" }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}

          const stack = yield* apply(A, B);
          expect(stack.A.stableId).toEqual("stable-A");
          expect(stack.B.string).toEqual("stable-A");
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
        }

        // Stage 2: Add tags to A - diff returns undefined, but arePropsChanged is true
        // B depends on A.stableId which should remain stable
        {
          class A extends StaticStablesResource("A", {
            string: "value",
            tags: { Name: "tagged-resource" },
          }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}

          const stack = yield* apply(A, B);
          // A should be updated (tags changed)
          expect(stack.A.tags).toEqual({ Name: "tagged-resource" });
          // B should NOT be updated because stableId didn't change
          expect(stack.B.string).toEqual("stable-A");
          expect((yield* getState("A"))?.status).toEqual("updated");
          // B should remain "created" (noop) since its input (stableId) didn't change
          expect((yield* getState("B"))?.status).toEqual("created");
        }
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "chain: A -> B -> C where B depends on A.stableId and C depends on B.stableString",
      Effect.gen(function* () {
        // Stage 1: Create chain
        {
          class A extends StaticStablesResource("A", { string: "initial" }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}
          class C extends TestResource("C", {
            string: Output.of(B).stableString,
          }) {}

          const stack = yield* apply(A, B, C);
          expect(stack.A.stableId).toEqual("stable-A");
          expect(stack.B.string).toEqual("stable-A");
          expect(stack.C.string).toEqual("B");
        }

        // Stage 2: Change A's tags only - diff returns undefined
        // Neither B nor C should update since their inputs are stable
        {
          class A extends StaticStablesResource("A", {
            string: "initial",
            tags: { Env: "production" },
          }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}
          class C extends TestResource("C", {
            string: Output.of(B).stableString,
          }) {}

          const stack = yield* apply(A, B, C);
          expect(stack.A.tags).toEqual({ Env: "production" });
          expect((yield* getState("A"))?.status).toEqual("updated");
          // B and C should not change
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
        }
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "diamond: A -> B,C -> D where all depend on stable properties",
      Effect.gen(function* () {
        // Stage 1: Create diamond
        {
          class A extends StaticStablesResource("A", { string: "initial" }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}
          class C extends TestResource("C", {
            string: Output.of(A).stableArn,
          }) {}
          class D extends TestResource("D", {
            string: Output.all(
              Output.of(B).stableString,
              Output.of(C).stableString,
            ).apply(([b, c]) => `${b}-${c}`),
          }) {}

          const stack = yield* apply(A, B, C, D);
          expect(stack.A.stableId).toEqual("stable-A");
          expect(stack.A.stableArn).toEqual(
            "arn:test:resource:us-east-1:123456789:A",
          );
          expect(stack.B.string).toEqual("stable-A");
          expect(stack.C.string).toEqual(
            "arn:test:resource:us-east-1:123456789:A",
          );
          expect(stack.D.string).toEqual("B-C");
        }

        // Stage 2: Change A's tags - should not affect B, C, or D
        {
          class A extends StaticStablesResource("A", {
            string: "initial",
            tags: { Team: "platform" },
          }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}
          class C extends TestResource("C", {
            string: Output.of(A).stableArn,
          }) {}
          class D extends TestResource("D", {
            string: Output.all(
              Output.of(B).stableString,
              Output.of(C).stableString,
            ).apply(([b, c]) => `${b}-${c}`),
          }) {}

          const stack = yield* apply(A, B, C, D);
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");
        }
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("diff returns update action with static stables", () => {
    test(
      "upstream has static stables and diff returns update, downstream depends on stableId",
      Effect.gen(function* () {
        // Stage 1: Create A and B
        {
          class A extends StaticStablesResource("A", { string: "value-1" }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}

          const stack = yield* apply(A, B);
          expect(stack.A.stableId).toEqual("stable-A");
          expect(stack.B.string).toEqual("stable-A");
        }

        // Stage 2: Change A's string - diff returns "update", stableId still stable
        {
          class A extends StaticStablesResource("A", { string: "value-2" }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}

          const stack = yield* apply(A, B);
          expect(stack.A.string).toEqual("value-2");
          expect(stack.A.stableId).toEqual("stable-A");
          expect((yield* getState("A"))?.status).toEqual("updated");
          // B should not change since stableId is stable
          expect((yield* getState("B"))?.status).toEqual("created");
        }
      }).pipe(Effect.provide(MockLayers())),
    );

    test(
      "downstream depends on non-stable property, should update",
      Effect.gen(function* () {
        // Stage 1: Create A and B where B depends on A.string (non-stable)
        {
          class A extends StaticStablesResource("A", { string: "value-1" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}

          const stack = yield* apply(A, B);
          expect(stack.A.string).toEqual("value-1");
          expect(stack.B.string).toEqual("value-1");
        }

        // Stage 2: Change A's string - B should update
        {
          class A extends StaticStablesResource("A", { string: "value-2" }) {}
          class B extends TestResource("B", { string: Output.of(A).string }) {}

          const stack = yield* apply(A, B);
          expect(stack.A.string).toEqual("value-2");
          expect(stack.B.string).toEqual("value-2");
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
        }
      }).pipe(Effect.provide(MockLayers())),
    );
  });

  describe("replace action with static stables", () => {
    test(
      "upstream replaces, downstream depends on stableId - should update with new value",
      Effect.gen(function* () {
        // Stage 1: Create A and B
        {
          class A extends StaticStablesResource("A", {
            string: "value",
            replaceString: "original",
          }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}

          const stack = yield* apply(A, B);
          expect(stack.A.stableId).toEqual("stable-A");
          expect(stack.B.string).toEqual("stable-A");
        }

        // Stage 2: Replace A - stableId will change (new resource)
        {
          class A extends StaticStablesResource("A", {
            string: "value",
            replaceString: "changed",
          }) {}
          class B extends TestResource("B", {
            string: Output.of(A).stableId,
          }) {}

          const stack = yield* apply(A, B);
          // A was replaced, stableId is regenerated
          expect(stack.A.stableId).toEqual("stable-A");
          expect(stack.B.string).toEqual("stable-A");
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
        }
      }).pipe(Effect.provide(MockLayers())),
    );
  });
});
