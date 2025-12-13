import type { Resource } from "@/resource";
import type { Input, InputProps } from "@/input";
import * as Output from "@/output";
import { plan, type TransitiveResources, type TraverseResources } from "@/plan";
import * as State from "@/state";
import { test } from "@/test";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Bucket,
  Function,
  Queue,
  TestLayers,
  TestResource,
  type TestResourceProps,
} from "./test.resources";
import * as App from "@/app";

const _test = test;

class MyBucket extends Bucket("MyBucket", {
  name: "test-bucket",
}) {}

class MyQueue extends Queue("MyQueue", {
  name: "test-queue",
}) {}

class MyFunction extends Function("MyFunction", {
  name: "test-function",
  env: {
    QUEUE_URL: Output.of(MyQueue).queueUrl,
  },
}) {}

test(
  "create all resources when plan is empty",
  {
    state: test.state(),
  },
  Effect.gen(function* () {
    expect(yield* plan(MyBucket, MyQueue)).toMatchObject({
      resources: {
        MyBucket: {
          action: "create",
          bindings: [],
          news: {
            name: "test-bucket",
          },
          attributes: undefined,
          resource: MyBucket,
        },
        MyQueue: {
          action: "create",
          bindings: [],
          news: {
            name: "test-queue",
          },
          attributes: undefined,
          resource: MyQueue,
        },
      },
      deletions: expect.emptyObject(),
    });
  }).pipe(Effect.provide(TestLayers)),
);

test(
  "update the changed resources and no-op un-changed resources",
  {
    state: test.state({
      MyBucket: {
        id: "MyBucket",
        type: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        output: {
          name: "test-bucket",
        },
        bindings: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(yield* plan(MyBucket, MyQueue)).toMatchObject({
      resources: {
        MyBucket: {
          action: "noop",
          bindings: [],
          attributes: undefined,
          resource: MyBucket,
        },
        MyQueue: {
          action: "create",
          bindings: [],
          news: {
            name: "test-queue",
          },
          attributes: undefined,
          resource: MyQueue,
        },
      },
      deletions: expect.emptyObject(),
    });
  }).pipe(Effect.provide(TestLayers)),
);

test(
  "delete oprhaned resources",
  {
    state: test.state({
      MyBucket: {
        id: "MyBucket",
        type: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        output: {
          name: "test-bucket",
        },
        bindings: [],
      },
      MyQueue: {
        id: "MyQueue",
        type: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue",
        },
        output: {
          name: "test-queue",
        },
        bindings: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(yield* plan(MyQueue)).toMatchObject({
      resources: {
        MyQueue: {
          action: "noop",
          bindings: [],
          attributes: undefined,
          resource: MyQueue,
        },
      },
      deletions: {
        MyBucket: {
          action: "delete",
          bindings: [],
          attributes: {
            name: "test-bucket",
          },
          resource: {
            id: "MyBucket",
            type: "Test.Bucket",
            props: {
              name: "test-bucket",
            },
          },
        },
      },
    });
  }).pipe(Effect.provide(TestLayers)),
);

test(
  "lazy Output queue.queueUrl to Function.env",
  Effect.gen(function* () {
    expect(yield* plan(MyFunction)).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          attributes: undefined,
          resource: MyFunction,
          news: {
            name: "test-function",
            env: {
              QUEUE_URL: expect.propExpr("queueUrl", MyQueue),
            },
          },
        },
      },
      deletions: expect.emptyObject(),
    });
  }).pipe(Effect.provide(TestLayers)),
);

test(
  "detect that queueUrl will change and pass through the PropExpr instead of old output",
  {
    state: test.state({
      MyQueue: {
        id: "MyQueue",
        type: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue-old",
        },
        output: {
          queueUrl: "https://test.queue.com/test-queue-old",
        },
      },
    }),
  },
  Effect.gen(function* () {
    expect(yield* plan(MyFunction)).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          attributes: undefined,
          resource: MyFunction,
          news: {
            name: "test-function",
            env: {
              QUEUE_URL: expect.propExpr("queueUrl", MyQueue),
            },
          },
        },
      },
      deletions: expect.emptyObject(),
    });
  }).pipe(Effect.provide(TestLayers)),
);

describe("Outputs should resolve to old values", () => {
  const state = _test.state({
    A: {
      id: "A",
      type: "Test.TestResource",
      status: "created",
      props: {
        string: "test-string",
        stringArray: ["test-string"],
      },
      output: {
        string: "test-string",
        stringArray: ["test-string"],
      },
    },
  });
  class A extends TestResource("A", {
    string: "test-string",
    stringArray: ["test-string"],
  }) {}
  const expected = (news: TestResourceProps) => ({
    resources: {
      A: {
        action: "noop",
        bindings: [],
        attributes: undefined,
      },
      B: {
        action: "create",
        bindings: [],
        attributes: undefined,
        news,
      },
    },
    deletions: expect.emptyObject(),
  });

  const createPlan = (props: InputProps<TestResourceProps>) =>
    plan(class B extends TestResource("B", props) {});

  const test = <const I extends InputProps<TestResourceProps>>(
    description: string,
    input: I,
    output: Input.Resolve<I>,
  ) =>
    _test(
      description,
      {
        state,
      },
      Effect.gen(function* () {
        expect(yield* createPlan(input)).toMatchObject(expected(output));
      }).pipe(Effect.provide(TestLayers)),
    );

  test(
    "string",
    {
      string: Output.of(A).string,
    },
    {
      string: "test-string",
    },
  );

  test(
    "string.apply(string => undefined)",
    {
      string: Output.of(A).string.apply((string) => undefined),
    },
    {
      string: undefined,
    },
  );

  test(
    "string.effect(string => Effect.succeed(undefined))",
    {
      string: Output.of(A).string.effect((string) => Effect.succeed(undefined)),
    },
    {
      string: undefined,
    },
  );

  test(
    "stringArray[0].toUpperCase()",
    {
      string: Output.of(A).stringArray[0].apply((string) =>
        string.toUpperCase(),
      ),
    },
    {
      string: "TEST-STRING",
    },
  );
});

describe("stable properties should not cause downstream changes", () => {
  class A extends TestResource("A", {
    string: "test-string",
  }) {}

  const test = (description: string, input: InputProps<TestResourceProps>) => {
    class B extends TestResource("B", input) {}

    _test(
      description,
      {
        state: _test.state({
          A: {
            id: "A",
            type: "Test.TestResource",
            status: "created",
            props: {
              string: "test-string-old",
            },
            output: {
              string: "test-string-old",
              stableString: "A",
              stableArray: ["A"],
            },
          },
          B: {
            id: "B",
            type: "Test.TestResource",
            status: "created",
            props: Object.fromEntries(
              Object.entries({
                string: "A",
                stringArray: ["A"],
              }).filter(([key]) => key in input),
            ),
            output: {
              stableString: "A",
            },
          },
        }),
      },
      Effect.gen(function* () {
        expect(yield* plan(A, B)).toMatchObject({
          resources: {
            A: {
              action: "update",
              news: {
                string: "test-string",
              },
            },
            B: {
              action: "noop",
            },
          },
          deletions: expect.emptyObject(),
        });
      }).pipe(Effect.provide(TestLayers)),
    );
  };

  test("A.stableString", {
    string: Output.of(A).stableString,
  });

  test("A.stableString.apply((string) => string.toUpperCase())", {
    string: Output.of(A).stableString.apply((string) => string.toUpperCase()),
  });

  test(
    "A.stableString.effect((string) => Effect.succeed(string.toUpperCase()))",
    {
      string: Output.of(A).stableString.effect((string) =>
        Effect.succeed(string.toUpperCase()),
      ),
    },
  );

  test("A.stableArray", {
    stringArray: Output.of(A).stableArray,
  });

  test("A.stableArray[0]", {
    string: Output.of(A).stableArray[0],
  });

  test("A.stableArray[0].apply((string) => string.toUpperCase())", {
    string: Output.of(A).stableArray[0].apply((string) => string.toUpperCase()),
  });

  test(
    "A.stableArray[0].effect((string) => Effect.succeed(string.toUpperCase()))",
    {
      string: Output.of(A).stableArray[0].effect((string) =>
        Effect.succeed(string.toUpperCase()),
      ),
    },
  );
});

const g = Effect.gen(function* () {
  {
    const p = yield* plan(MyFunction);
    p.resources.MyFunction;
    // transitive dependency detected via outputs
    p.resources.MyQueue;
    // TODO(sam): test multiple transitive hops
  }
  {
    class A extends TestResource("A", {}) {}
    class B extends TestResource("B", {
      string: Output.of(A).string,
    }) {}
    class C extends TestResource("C", {
      string: Output.of(B).string,
    }) {}
    const p = yield* plan(C);
    p.resources.A;
    p.resources.B;
    p.resources.C;
    // @ts-expect-error
    p.resources.D;

    // attest(
    //   yield* plan(C),
    // );

    // attest.instantiations([3500, "instantiations"]);
  }
}).pipe(Effect.provide(TestLayers));

describe.skip("type-only tests", () => {
  test(
    "infer transitive dependencies via outputs",
    Effect.gen(function* () {
      {
        const p = yield* plan(MyFunction);
        p.resources.MyFunction;
        // transitive dependency detected via outputs
        p.resources.MyQueue;
        // TODO(sam): test multiple transitive hops
      }
      {
        class A extends TestResource("A", {}) {}
        class B extends TestResource("B", {
          string: Output.of(A).string,
        }) {}
        class C extends TestResource("C", {
          string: Output.of(B).string,
        }) {}
        const p = yield* plan(C);

        p.resources.A;
        p.resources.B;
        p.resources.C;
        // @ts-expect-error
        p.resources.D;

        {
          // any type should not break the type inference
          class D extends TestResource("D", {
            string: undefined! as any,
            object: {
              string: undefined! as any,
            },
          }) {}
          type _ = TraverseResources<D>;
          const p = yield* plan(D);
          p.resources.D;
          // @ts-expect-error
          p.resources.E;
        }
      }
    }).pipe(Effect.provide(TestLayers)),
  );
});
