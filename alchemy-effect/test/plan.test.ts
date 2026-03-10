import type { Input, InputProps } from "@/Input";
import * as Output from "@/Output";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import { State, type ResourceState, type ResourceStatus } from "@/State";
import { test } from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Stage } from "../src/Stage.ts";
import {
  BindingTarget,
  Bucket,
  Function,
  Queue,
  TestLayers,
  TestResource,
  type TestResourceProps,
} from "./test.resources";

const _test = test;

const instanceId = "852f6ec2e19b66589825efe14dca2971";

const makePlan = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<Stack.StackSpec & { output: A }, Err, never> =>
  // @ts-expect-error
  Effect.gen(function* () {
    const stack = yield* Stack.Stack;
    // @ts-expect-error
    return yield* effect.pipe(
      // @ts-expect-error
      Stack.make(stack.name, Layer.empty),
      Effect.provideService(Stage, stack.stage),
      Effect.flatMap(Plan.make),
      Effect.provide(TestLayers),
    );
  });

test(
  "create all resources when plan is empty",
  {
    state: test.state(),
  },
  Effect.gen(function* () {
    expect(
      yield* Effect.gen(function* () {
        const bucket = yield* Bucket("MyBucket", {
          name: "test-bucket",
        });
        const queue = yield* Queue("MyQueue", {
          name: "test-queue",
        });

        return {
          queueUrl: queue.queueUrl,
          bucketArn: bucket.bucketArn,
        };
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        MyBucket: {
          action: "create",
          bindings: [],
          props: {
            name: "test-bucket",
          },
          state: undefined,
        },
        MyQueue: {
          action: "create",
          bindings: [],
          props: {
            name: "test-queue",
          },
          state: undefined,
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

test(
  "update the changed resources and no-op un-changed resources",
  {
    state: test.state({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        fqn: "MyBucket",
        namespace: undefined,
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
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Bucket("MyBucket", {
            name: "test-bucket",
          });
          yield* Queue("MyQueue", {
            name: "test-queue",
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyBucket: {
          action: "noop",
          bindings: [],
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
          state: undefined,
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

test(
  "no-op resources with undefined props",
  {
    state: test.state({
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        fqn: "MyQueue",
        namespace: undefined,
        resourceType: "Test.Queue",
        status: "created",
        props: undefined as any,
        attr: {
          name: "MyQueue",
          queueUrl: "https://test.queue.com/MyQueue",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Queue("MyQueue");
        }),
      ),
    ).toMatchObject({
      resources: {
        MyQueue: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

test(
  "no-op resources when object prop key order changes",
  {
    state: test.state({
      MyFunction: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyFunction",
        fqn: "MyFunction",
        namespace: undefined,
        resourceType: "Test.Function",
        status: "created",
        props: {
          name: "test-function",
          env: {
            A: "1",
            B: "2",
          },
        },
        attr: {
          name: "test-function",
          env: {
            A: "1",
            B: "2",
          },
          functionArn: "arn:test:function:MyFunction",
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Function("MyFunction", {
            name: "test-function",
            env: {
              B: "2",
              A: "1",
            },
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyFunction: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

test(
  "delete orphaned resources",
  {
    state: test.state({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        fqn: "MyBucket",
        namespace: undefined,
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
        fqn: "MyQueue",
        namespace: undefined,
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
    const state = yield* State;
    const resourceIds = yield* state.list({
      stack: "test",
      stage: "test",
    });
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Queue("MyQueue", {
            name: "test-queue",
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyQueue: {
          action: "noop",
          bindings: [],
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
            LogicalId: "MyBucket",
            Type: "Test.Bucket",
            Props: {
              name: "test-bucket",
            },
          },
        },
      },
    });
  }),
);

test(
  "replace resource when replaceString changes",
  {
    state: test.state({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.TestResource",
        status: "created",
        props: {
          replaceString: "A",
        },
        attr: {},
        downstream: [],
        bindings: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "A",
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "noop",
        },
      },
      deletions: expect.emptyObject(),
    });

    expect(
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "B",
        });
      }).pipe(makePlan),
    ).toMatchObject({
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

    let B: TestResource;
    expect(
      yield* Effect.gen(function* () {
        B = yield* TestResource("B", {
          string: "A",
        });
        yield* TestResource("A", {
          replaceString: B.string,
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "replace",
          props: {
            replaceString: expect.propExpr("string", B!),
          },
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

test(
  "update resource when a binding is added without prop changes",
  {
    state: test.state({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.BindingTarget",
        status: "created",
        props: {
          name: "target",
        },
        attr: {
          name: "target",
          env: {},
        },
        bindings: [],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* Effect.gen(function* () {
        const target = yield* BindingTarget("A", {
          name: "target",
        });
        yield* target.bind("TestBinding", {
          env: {
            FEATURE_FLAG: "on",
          },
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "update",
          bindings: [
            {
              action: "create",
              sid: "TestBinding",
              data: {
                env: {
                  FEATURE_FLAG: "on",
                },
              },
            },
          ],
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

test(
  "update resource when a binding is removed without prop changes",
  {
    state: test.state({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.BindingTarget",
        status: "created",
        props: {
          name: "target",
        },
        attr: {
          name: "target",
          env: {
            FEATURE_FLAG: "on",
          },
        },
        bindings: [
          {
            namespace: undefined,
            sid: "TestBinding",
            data: {
              env: {
                FEATURE_FLAG: "on",
              },
            },
          },
        ],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    expect(
      yield* Effect.gen(function* () {
        yield* BindingTarget("A", {
          name: "target",
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "update",
          bindings: [
            {
              action: "delete",
              sid: "TestBinding",
              data: {
                env: {
                  FEATURE_FLAG: "on",
                },
              },
            },
          ],
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

test(
  "binding removals do not keep reappearing after apply",
  {
    state: test.state({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.BindingTarget",
        status: "created",
        props: {
          name: "target",
        },
        attr: {
          name: "target",
          env: {
            FEATURE_FLAG: "on",
          },
        },
        bindings: [
          {
            namespace: undefined,
            sid: "TestBinding",
            data: {
              env: {
                FEATURE_FLAG: "on",
              },
            },
          },
        ],
        downstream: [],
      },
    }),
  },
  Effect.gen(function* () {
    const stack = yield* Stack.Stack;
    const state = yield* State;

    yield* test.deploy(
      Effect.gen(function* () {
        yield* BindingTarget("A", {
          name: "target",
        });
      }),
    ).pipe(Effect.provide(TestLayers));

    expect(
      yield* state.get({
        stack: stack.name,
        stage: stack.stage,
        fqn: "A",
      }),
    ).toMatchObject({
      bindings: [],
    });

    expect(
      yield* Effect.gen(function* () {
        yield* BindingTarget("A", {
          name: "target",
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "noop",
          bindings: [],
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
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
    bindings: [],
    fqn: options.logicalId,
    namespace: undefined,
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
        const plan = Effect.gen(function* () {
          yield* TestResource("A", testCase.props);
        }).pipe(makePlan);

        if (testCase.fail) {
          const result = plan.pipe(
            Effect.map(() => false),
            // @ts-expect-error
            Effect.catchTag(testCase.fail, () => Effect.succeed(true)),
            Effect.catch(() => Effect.succeed(false)),
          ) as Effect.Effect<boolean>;
          if (!result) {
            expect.fail(`Expected error '${testCase.fail}`);
          }
        } else {
          expect(yield* plan).toMatchObject({
            resources: {
              A: testCase.plan,
            },
            deletions: expect.emptyObject(),
          });
        }
      }
    }),
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
    let MyQueue: Queue;
    let MyFunction: Function;
    const plan = yield* Effect.gen(function* () {
      MyQueue = yield* Queue("MyQueue");
      MyFunction = yield* Function("MyFunction", {
        name: "test-function",
        env: {
          QUEUE_URL: MyQueue.queueUrl,
        },
      });
    }).pipe(makePlan);
    expect(plan).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          resource: MyFunction!,
          props: {
            name: "test-function",
            env: {
              QUEUE_URL: expect.propExpr("queueUrl", MyQueue!),
            },
          },
          state: undefined,
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

test(
  "detect that queueUrl will change and pass through the PropExpr instead of old output",
  {
    state: test.state({
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        fqn: "MyQueue",
        namespace: undefined,
        resourceType: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue-old",
        },
        attr: {
          queueUrl: "https://test.queue.com/test-queue-old",
        },
        downstream: [],
        bindings: [],
      },
    }),
  },
  Effect.gen(function* () {
    let MyQueue: Queue;
    let MyFunction: Function;
    const plan = yield* Effect.gen(function* () {
      MyQueue = yield* Queue("MyQueue");
      MyFunction = yield* Function("MyFunction", {
        name: "test-function",
        env: {
          QUEUE_URL: MyQueue.queueUrl,
        },
      });
    }).pipe(makePlan);
    expect(plan).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          resource: MyFunction!,
          props: {
            name: "test-function",
            env: {
              QUEUE_URL: expect.propExpr("queueUrl", MyQueue!),
            },
          },
          state: undefined,
        },
      },
      deletions: expect.emptyObject(),
    });
  }),
);

describe("Outputs should resolve to old values", () => {
  const state = _test.state({
    A: {
      instanceId,
      providerVersion: 0,
      logicalId: "A",
      fqn: "A",
      namespace: undefined,
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
      bindings: [],
    },
  });

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

  const test = <const I extends InputProps<TestResourceProps>>(
    description: string,
    input: (resource: TestResource) => I,
    attr: Input.Resolve<I>,
  ) =>
    _test(
      description,
      {
        state,
      },
      Effect.gen(function* () {
        expect(
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "test-string",
              stringArray: ["test-string"],
            });
            yield* TestResource("B", input(A));
          }).pipe(makePlan),
        ).toMatchObject(expected(attr));
      }),
    );

  test(
    "string",
    (A) => ({
      string: A.string,
    }),
    {
      string: "test-string",
    },
  );

  test(
    "string.apply(string => undefined)",
    (A) => ({
      string: A.string.pipe(Output.map(() => undefined)),
    }),
    {
      string: undefined,
    },
  );

  test(
    "string.effect(string => Effect.succeed(undefined))",
    (A) => ({
      string: A.string.pipe(Output.mapEffect(() => Effect.succeed(undefined))),
    }),
    {
      string: undefined,
    },
  );

  test(
    "stringArray[0].toUpperCase()",
    (A) => ({
      string: A.stringArray.pipe(
        Output.map((stringArray) => stringArray[0]!.toUpperCase()),
      ),
    }),
    {
      string: "TEST-STRING",
    },
  );
});

describe("stable properties should not cause downstream changes", () => {
  const test = (
    description: string,
    input: (A: TestResource) => Input<TestResourceProps>,
  ) => {
    // @ts-expect-error - get the keys
    const props = input(Output.of({}));
    _test(
      description,
      {
        state: _test.state({
          A: {
            instanceId,
            providerVersion: 0,
            logicalId: "A",
            fqn: "A",
            namespace: undefined,
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
            bindings: [],
          },
          B: {
            instanceId,
            providerVersion: 0,
            logicalId: "B",
            fqn: "B",
            namespace: undefined,
            resourceType: "Test.TestResource",
            status: "created",
            props: Object.fromEntries(
              Object.entries({
                string: "A",
                stringArray: ["A"],
              }).filter(([key]) => key in props),
            ),
            attr: {
              stableString: "A",
            },
            downstream: [],
            bindings: [],
          },
        }),
      },
      Effect.gen(function* () {
        expect(
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "test-string",
            });
            yield* TestResource("B", input(A));
          }).pipe(makePlan),
        ).toMatchObject({
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
      }),
    );
  };

  test("A.stableString", (A) => ({
    string: A.stableString,
  }));

  test("A.stableString.apply((string) => string.toUpperCase())", (A) => ({
    string: A.stableString.pipe(Output.map((string) => string.toUpperCase())),
  }));

  test("A.stableString.effect((string) => Effect.succeed(string.toUpperCase()))", (A) => ({
    string: A.stableString.pipe(
      Output.mapEffect((string) => Effect.succeed(string.toUpperCase())),
    ),
  }));

  test("A.stableArray", (A) => ({
    stringArray: A.stableArray,
  }));

  test("A.stableArray[0]", (A) => ({
    string: A.stableArray.pipe(Output.map((stableArray) => stableArray[0]!)),
  }));

  test("A.stableArray[0].apply((string) => string.toUpperCase())", (A) => ({
    string: A.stableArray.pipe(
      Output.map((stableArray) => stableArray[0]!.toUpperCase()),
    ),
  }));

  test("A.stableArray[0].effect((string) => Effect.succeed(string.toUpperCase()))", (A) => ({
    string: A.stableArray.pipe(
      Output.mapEffect((stableArray) =>
        Effect.succeed(stableArray[0]!.toUpperCase()),
      ),
    ),
  }));
});
