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
  InMemoryTestLayers,
  TestLayers,
  TestResource,
  TestResourceHooks,
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

const MockLayers = () => Layer.mergeAll(InMemoryTestLayers(), Layer.succeed(App, mockApp));

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
    id === resourceId ? Effect.fail(new ResourceFailure()) : Effect.succeed(undefined),
});

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
          string: Output.of(A).stringArray[0].apply((string) => string.toUpperCase()),
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
        expect(stack.B.stringArray).toEqual(["test-string-array", "test-string-array"]);
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
        expect(result.left).toBeInstanceOf(CannotReplacePartiallyReplacedResource);
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
        expect(result.left).toBeInstanceOf(CannotReplacePartiallyReplacedResource);
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
        expect(result.left).toBeInstanceOf(CannotReplacePartiallyReplacedResource);
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

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual("replacing");
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
        expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual("replaced");
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
