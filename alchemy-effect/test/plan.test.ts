import type { Input, InputProps } from "@/input";
import * as Output from "@/output";
import { type CRUD, type IPlan, plan, type TraverseResources } from "@/plan";
import { test } from "@/test";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  Bucket,
  Function,
  Queue,
  TestLayers,
  TestResource,
  type TestResourceProps,
} from "./test.resources";
import type { ResourceState, ResourceStatus } from "@/state";

const _test = test;

const instanceId = "852f6ec2e19b66589825efe14dca2971";

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
          props: {
            name: "test-bucket",
          },
          state: undefined,
          resource: MyBucket,
        },
        MyQueue: {
          action: "create",
          bindings: [],
          props: {
            name: "test-queue",
          },
          state: undefined,
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
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        resourceType: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        attr: {
          name: "test-bucket",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(yield* plan(MyBucket, MyQueue)).toMatchObject({
      resources: {
        MyBucket: {
          action: "noop",
          bindings: [],
          resource: MyBucket,
          state: {
            status: "created",
          },
        },
        MyQueue: {
          action: "create",
          bindings: [],
          props: {
            name: "test-queue",
          },
          resource: MyQueue,
          state: undefined,
        },
      },
      deletions: expect.emptyObject(),
    });
  }).pipe(Effect.provide(TestLayers)),
);

test(
  "delete orphaned resources",
  {
    state: test.state({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        resourceType: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        attr: {
          name: "test-bucket",
        },
        bindings: [],
        downstream: [],
      },
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        resourceType: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue",
        },
        attr: {
          name: "test-queue",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(yield* plan(MyQueue)).toMatchObject({
      resources: {
        MyQueue: {
          action: "noop",
          bindings: [],
          resource: MyQueue,
          state: {
            status: "created",
          },
        },
      },
      deletions: {
        MyBucket: {
          action: "delete",
          bindings: [],
          state: {
            status: "created",
            attr: {
              name: "test-bucket",
            },
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
  "replace resource when replaceString changes",
  {
    state: test.state({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        resourceType: "Test.TestResource",
        status: "created",
        props: {
          replaceString: "A",
        },
        attr: {},
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    {
      class A extends TestResource("A", {
        replaceString: "A",
      }) {}

      // replaceString is the same
      expect(yield* plan(A)).toMatchObject({
        resources: {
          A: {
            action: "noop",
          },
        },
      });
    }

    {
      class A extends TestResource("A", {
        replaceString: "B",
      }) {}
      expect(yield* plan(A)).toMatchObject({
        resources: {
          A: {
            action: "replace",
            props: {
              replaceString: "B",
            },
          },
        },
        deletions: expect.emptyObject(),
      });
    }

    {
      class B extends TestResource("B", {
        string: "A",
      }) {}
      class A extends TestResource("A", {
        string: Output.of(B).string,
      }) {}

      const p = yield* plan(A);
      expect(p).toMatchObject({
        resources: {
          A: {
            action: "replace",
            props: {
              string: expect.propExpr("string", B),
            },
          },
        },
        deletions: expect.emptyObject(),
      });
    }
  }).pipe(Effect.provide(TestLayers)),
);

const createTestResourceState = (options: {
  logicalId: string;
  status: ResourceStatus;
  props: TestResourceProps;
  attr?: {};
}) =>
  ({
    instanceId,
    providerVersion: 0,
    ...options,
    resourceType: "Test.TestResource",
    attr: options.attr ?? {},
    downstream: [],
  }) as ResourceState;

const testSimple = (
  title: string,
  testCase: {
    state: {
      status: ResourceStatus;
      props: TestResourceProps;
      attr?: {};
      old?: Partial<ResourceState>;
    };
    props: TestResourceProps;
    plan?: any;
    fail?: string;
  },
) =>
  test(
    title,
    {
      state: test.state({
        A: createTestResourceState({
          ...testCase.state,
          logicalId: "A",
        }),
      }),
    },
    Effect.gen(function* () {
      {
        class A extends TestResource("A", testCase.props) {}
        if (testCase.fail) {
          const result = yield* plan(A).pipe(
            Effect.map(() => false),
            // @ts-expect-error
            Effect.catchTag(testCase.fail, () => Effect.succeed(true)),
            Effect.catchAll(() => Effect.succeed(false)),
          ) as Effect.Effect<boolean>;
          if (!result) {
            expect.fail(`Expected error '${testCase.fail}`);
          }
        } else {
          expect(yield* plan(A)).toMatchObject({
            resources: {
              A: testCase.plan,
            },
            deletions: expect.emptyObject(),
          });
        }
      }
    }).pipe(Effect.provide(TestLayers)),
  );

describe("prior crash in 'creating' state", () => {
  testSimple("create if props unchanged", {
    state: {
      status: "creating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "A",
    },
    plan: {
      action: "create",
      props: {
        string: "A",
      },
    },
  });

  testSimple("create if changed props can be updated", {
    state: {
      status: "creating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "B",
    },
    plan: {
      action: "create",
      props: {
        string: "B",
      },
    },
  });

  testSimple("replace if changed props cannot be updated", {
    state: {
      status: "creating",
      props: {
        replaceString: "A",
      },
    },
    props: {
      replaceString: "B",
    },
    plan: {
      action: "replace",
      props: {
        replaceString: "B",
      },
      state: {
        status: "creating",
        props: {
          replaceString: "A",
        },
      },
    },
  });
});

describe("prior crash in 'updating' state", () => {
  testSimple("update if props unchanged", {
    state: {
      status: "updating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "A",
    },
    plan: {
      action: "update",
      props: {
        string: "A",
      },
      state: {
        status: "updating",
        props: {
          string: "A",
        },
      },
    },
  });

  testSimple("update if changed props can be updated", {
    state: {
      status: "updating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "B",
    },
    plan: {
      action: "update",
      props: {
        string: "B",
      },
      state: {
        status: "updating",
        props: {
          string: "A",
        },
      },
    },
  });

  testSimple("replace if changed props can not be updated", {
    state: {
      status: "updating",
      props: {
        replaceString: "A",
      },
    },
    props: {
      replaceString: "B",
    },
    plan: {
      action: "replace",
      props: {
        replaceString: "B",
      },
      state: {
        status: "updating",
        props: {
          replaceString: "A",
        },
      },
    },
  });
});

describe("prior crash in 'replacing' state", () => {
  const priorStates = ["created", "creating", "updated", "updating"] as const;

  const testUnchanged = ({
    old,
  }: {
    old: {
      status: ResourceStatus;
    };
  }) =>
    testSimple(
      `"continue 'replace' if props are unchanged and previous state is '${old.status}'"`,
      {
        state: {
          status: "replacing",
          props: {
            string: "A",
          },
          old,
        },
        props: {
          string: "A",
        },
        plan: {
          action: "replace",
          props: {
            string: "A",
          },
          state: {
            status: "replacing",
            props: {
              string: "A",
            },
            old,
          },
        },
      },
    );

  priorStates.forEach((status) =>
    testUnchanged({
      old: {
        status,
      },
    }),
  );

  const testMinorChange = ({
    old,
  }: {
    old: {
      status: ResourceStatus;
    };
  }) =>
    testSimple(
      `"continue 'replace' if props can be updated and previous state is '${old.status}'"`,
      {
        state: {
          status: "replacing",
          props: {
            string: "A",
          },
          old,
        },
        props: {
          string: "B",
        },
        plan: {
          action: "replace",
          props: {
            string: "B",
          },
          state: {
            status: "replacing",
            props: {
              string: "A",
            },
            old,
          },
        },
      },
    );

  priorStates.forEach((status) =>
    testMinorChange({
      old: {
        status,
      },
    }),
  );

  const testReplacement = (
    title: string,
    {
      old,
      plan,
      fail,
    }: {
      old: {
        status: ResourceStatus;
      };
      plan?: any;
      fail?: string;
    },
  ) =>
    testSimple(title, {
      state: {
        status: "replacing",
        props: {
          replaceString: "A",
        },
        old,
      },
      props: {
        replaceString: "B",
      },
      plan,
      fail,
    });

  (["replaced", "replacing"] as const).forEach((status) =>
    testReplacement(
      `fail if trying to replace a partially replaced resource in state '${status}'`,
      {
        old: {
          status,
        },
        fail: "CannotReplacePartiallyReplacedResource",
      },
    ),
  );
});

describe("prior crash in 'deleting' state", () => {
  testSimple(
    "create the resource if props are unchanged and the previous state is 'deleting'",
    {
      state: {
        status: "deleting",
        props: {
          string: "A",
        },
      },
      props: {
        string: "A",
      },
      plan: {
        action: "create",
        props: {
          string: "A",
        },
      },
    },
  );
});

test(
  "lazy Output queue.queueUrl to Function.env",
  Effect.gen(function* () {
    expect(yield* plan(MyFunction)).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          resource: MyFunction,
          props: {
            name: "test-function",
            env: {
              QUEUE_URL: expect.propExpr("queueUrl", MyQueue),
            },
          },
          state: undefined,
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
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        resourceType: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue-old",
        },
        attr: {
          queueUrl: "https://test.queue.com/test-queue-old",
        },
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(yield* plan(MyFunction)).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          resource: MyFunction,
          props: {
            name: "test-function",
            env: {
              QUEUE_URL: expect.propExpr("queueUrl", MyQueue),
            },
          },
          state: undefined,
        },
      },
      deletions: expect.emptyObject(),
    });
  }).pipe(Effect.provide(TestLayers)),
);

describe("Outputs should resolve to old values", () => {
  const state = _test.state({
    A: {
      instanceId,
      providerVersion: 0,
      logicalId: "A",
      resourceType: "Test.TestResource",
      status: "created",
      props: {
        string: "test-string",
        stringArray: ["test-string"],
      },
      attr: {
        string: "test-string",
        stringArray: ["test-string"],
      },
      downstream: [],
    },
  });
  class A extends TestResource("A", {
    string: "test-string",
    stringArray: ["test-string"],
  }) {}
  const expected = (props: TestResourceProps) => ({
    resources: {
      A: {
        action: "noop",
        bindings: [],
      },
      B: {
        action: "create",
        bindings: [],
        props: props,
      },
    },
    deletions: expect.emptyObject(),
  });

  const createPlan = (props: InputProps<TestResourceProps>) =>
    plan(class B extends TestResource("B", props) {});

  const test = <const I extends InputProps<TestResourceProps>>(
    description: string,
    input: I,
    attr: Input.Resolve<I>,
  ) =>
    _test(
      description,
      {
        state,
      },
      Effect.gen(function* () {
        expect(yield* createPlan(input)).toMatchObject(expected(attr));
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
            instanceId,
            providerVersion: 0,
            logicalId: "A",
            resourceType: "Test.TestResource",
            status: "created",
            props: {
              string: "test-string-old",
            },
            attr: {
              string: "test-string-old",
              stableString: "A",
              stableArray: ["A"],
            },
            downstream: [],
          },
          B: {
            instanceId,
            providerVersion: 0,
            logicalId: "B",
            resourceType: "Test.TestResource",
            status: "created",
            props: Object.fromEntries(
              Object.entries({
                string: "A",
                stringArray: ["A"],
              }).filter(([key]) => key in input),
            ),
            attr: {
              stableString: "A",
            },
            downstream: [],
          },
        }),
      },
      Effect.gen(function* () {
        expect(yield* plan(A, B)).toMatchObject({
          resources: {
            A: {
              action: "update",
              props: {
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
