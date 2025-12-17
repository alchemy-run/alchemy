import * as Effect from "effect/Effect";

import { apply } from "@/apply";
import { destroy } from "@/destroy";
import * as Output from "@/output";
import { type ReplacedResourceState, type ResourceState, State } from "@/state";
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

const testStack = "test";
const testStage = "test";

const getState = Effect.fn(function* <S = ResourceState>(resourceId: string) {
  const state = yield* State;
  return (yield* state.get({ stack: testStack, stage: testStage, resourceId })) as S;
});
const listState = Effect.fn(function* () {
  const state = yield* State;
  return yield* state.list({ stack: testStack, stage: testStage });
});

const mockApp = App.of({ name: testStack, stage: testStage, config: {} });

test(
  "apply should create when non-existent and update when props change",
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
  "apply should resolve output properties",
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

describe("recover from intermediate failures", () => {
  test(
    "should continue creating after failed create when props unchanged",
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
    "should continue creating after failed create when props have changed and are updatable",
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
    "should replace after failed create when props have changed and are not updatable",
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

  test(
    "should delete replaced resource after failing to delete it",
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
    "should continue updating after failed update when props unchanged",
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
    "should continue updating after failed update when props have changed and are updatable",
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
    "should replace after failed update when props have changed and are not updatable",
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

  test(
    "should create resource after failed delete",
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
});
