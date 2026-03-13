import { Resource } from "@/Resource";
import * as State from "@/State/index";
import { isUnknown } from "@/Util/unknown";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";

// Bucket
export type BucketProps = {
  name?: string;
};

export interface Bucket extends Resource<
  "Test.Bucket",
  BucketProps,
  {
    name: string;
    bucketArn: string;
  }
> {}

export const Bucket = Resource<Bucket>("Test.Bucket");

const bucketProvider = Bucket.provider.succeed({
  diff: Effect.fn(function* ({ id, news, output }) {}),
  create: Effect.fn(function* ({ id, news = {} }) {
    return {
      name: news.name ?? id,
      bucketArn: `arn:test:bucket:us-east-1:123456789:${id}`,
    };
  }),
  update: Effect.fn(function* ({ id, news, output }) {
    return output;
  }),
  delete: Effect.fn(function* ({ output }) {
    return;
  }),
});

// Queue
export type QueueProps = {
  name?: string;
};

export interface Queue extends Resource<
  "Test.Queue",
  QueueProps,
  {
    name: string;
    queueUrl: string;
  }
> {}

export const Queue = Resource<Queue>("Test.Queue");

export const queueProvider = Queue.provider.succeed({
  diff: Effect.fn(function* ({ id, news = {}, output }) {}),
  create: Effect.fn(function* ({ id, news = {} }) {
    const name = news.name ?? id;
    return {
      name,
      queueUrl: `https://test.queue.com/${name}`,
    };
  }),
  update: Effect.fn(function* ({ id, news = {}, output }) {
    const name = news.name ?? id;
    return {
      name,
      queueUrl: `https://test.queue.com/${name}`,
    };
  }),
  delete: Effect.fn(function* ({ output }) {}),
});

export type FunctionProps = {
  name?: string;
  env?: Record<string, string>;
};

export interface Function extends Resource<
  "Test.Function",
  FunctionProps,
  {
    name: string;
    env: Record<string, string>;
    functionArn: string;
  }
> {}

export const Function = Resource<Function>("Test.Function");

export const functionProvider = Function.provider.succeed({
  diff: Effect.fn(function* ({ id, news, output }) {}),
  create: Effect.fn(function* ({ id, news = {} }) {
    return {
      name: news.name ?? id,
      env: news.env ?? {},
      functionArn: `arn:aws:lambda:us-west-2:084828582823:function:${id}`,
    };
  }),
  update: Effect.fn(function* ({ id, news = {}, output }) {
    return {
      name: news.name ?? id,
      env: news.env ?? {},
      functionArn: `arn:aws:lambda:us-west-2:084828582823:function:${id}`,
    };
  }),
  delete: Effect.fn(function* ({ output }) {}),
});

export type BindingTargetProps = {
  name?: string;
  string?: string;
  replaceString?: string;
};

export interface BindingTarget extends Resource<
  "Test.BindingTarget",
  BindingTargetProps,
  {
    name: string;
    string: string;
    env: Record<string, string>;
    replaceString: BindingTargetProps["replaceString"];
  },
  {
    env?: Record<string, string>;
  }
> {}

export const BindingTarget = Resource<BindingTarget>("Test.BindingTarget");

export const bindingTargetProvider = BindingTarget.provider.effect(
  Effect.gen(function* () {
    return {
      diff: Effect.fn(function* ({ news = {}, olds = {} }) {
        if (news.replaceString !== olds.replaceString) {
          return {
            action: "replace",
          };
        }
        if (news.name !== olds.name || news.string !== olds.string) {
          return {
            action: "update",
          };
        }
        return undefined;
      }),
      precreate: Effect.fn(function* ({ id, news = {} }) {
        return {
          name: news.name ?? id,
          string: news.string ?? id,
          env: {},
          replaceString: news.replaceString,
        };
      }),
      create: Effect.fn(function* ({ id, news = {}, bindings }) {
        const hooks = Option.getOrUndefined(
          yield* Effect.serviceOption(TestResourceHooks),
        );
        if (hooks?.create) {
          yield* hooks.create(id, news as TestResourceProps);
        }
        return {
          name: news.name ?? id,
          string: news.string ?? id,
          env: Object.assign(
            {},
            ...bindings.map(
              (binding: any) => binding.env ?? binding.data?.env ?? {},
            ),
          ),
          replaceString: news.replaceString,
        };
      }),
      update: Effect.fn(function* ({ id, news = {}, bindings }) {
        const hooks = Option.getOrUndefined(
          yield* Effect.serviceOption(TestResourceHooks),
        );
        if (hooks?.update) {
          yield* hooks.update(id, news as TestResourceProps);
        }
        return {
          name: news.name ?? id,
          string: news.string ?? id,
          env: Object.assign(
            {},
            ...bindings.map(
              (binding: any) => binding.env ?? binding.data?.env ?? {},
            ),
          ),
          replaceString: news.replaceString,
        };
      }),
      delete: Effect.fn(function* ({ id }) {
        const hooks = Option.getOrUndefined(
          yield* Effect.serviceOption(TestResourceHooks),
        );
        if (hooks?.delete) {
          yield* hooks.delete(id);
        }
        return;
      }),
    };
  }),
);

export type DeletedBindingRegressionProps = {
  name?: string;
};

export interface DeletedBindingRegressionTarget extends Resource<
  "Test.DeletedBindingRegressionTarget",
  DeletedBindingRegressionProps,
  {
    name: string;
    env: Record<string, string>;
  },
  {
    env?: Record<string, string>;
  }
> {}

export const DeletedBindingRegressionTarget =
  Resource<DeletedBindingRegressionTarget>(
    "Test.DeletedBindingRegressionTarget",
  );

export const deletedBindingRegressionProvider =
  DeletedBindingRegressionTarget.provider.succeed({
    diff: Effect.fn(function* () {}),
    precreate: Effect.fn(function* ({ id, news = {} }) {
      return {
        name: news.name ?? id,
        env: {},
      };
    }),
    create: Effect.fn(function* ({ id, news = {}, bindings }) {
      return {
        name: news.name ?? id,
        env: Object.assign(
          {},
          ...bindings.map(
            (binding: any) => binding.env ?? binding.data?.env ?? {},
          ),
        ),
      };
    }),
    update: Effect.fn(function* ({ id, news = {}, bindings }) {
      return {
        name: news.name ?? id,
        env: Object.assign(
          {},
          ...bindings.map(
            (binding: any) => binding.env ?? binding.data?.env ?? {},
          ),
        ),
      };
    }),
    delete: Effect.fn(function* () {}),
  });

// TestResource

export type TestResourceProps = {
  string?: string;
  stringArray?: string[];
  object?: {
    string: string;
  };
  replaceString?: string;
};

export interface TestResource extends Resource<
  "Test.TestResource",
  TestResourceProps,
  {
    string: string;
    stringArray: string[];
    stableString: string;
    stableArray: string[];
    replaceString: TestResourceProps["replaceString"];
  }
> {}

export class TestResourceHooks extends ServiceMap.Service<
  TestResourceHooks,
  {
    create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    delete?: (id: string) => Effect.Effect<void, any>;
    read?: (id: string) => Effect.Effect<void, any>;
  }
>()("TestResourceHooks") {}

export const TestResource = Resource<TestResource>("Test.TestResource");

export const testResourceProvider = TestResource.provider.effect(
  Effect.gen(function* () {
    return {
      read: Effect.fn(function* ({ id, output }) {
        const hooks = Option.getOrUndefined(
          yield* Effect.serviceOption(TestResourceHooks),
        );
        if (hooks?.read) {
          return (yield* hooks.read(id)) as any;
        }
        return output;
      }),
      diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
        if (news.replaceString !== olds.replaceString) {
          return {
            action: "replace",
          };
        }
        return isUnknown(news.string) ||
          isUnknown(news.stringArray) ||
          news.string !== olds.string ||
          news.stringArray?.length !== olds.stringArray?.length ||
          !!news.stringArray !== !!olds.stringArray ||
          news.stringArray?.some(isUnknown) ||
          news.stringArray?.some((s, i) => s !== olds.stringArray?.[i])
          ? {
              action: "update",
              stables: ["stableString", "stableArray"],
            }
          : undefined;
      }),
      create: Effect.fn(function* ({ id, news = {} }) {
        const hooks = Option.getOrUndefined(
          yield* Effect.serviceOption(TestResourceHooks),
        );
        if (hooks?.create) {
          yield* hooks.create(id, news);
        }
        return {
          string: news.string ?? id,
          stringArray: news.stringArray ?? [],
          stableString: id,
          stableArray: [id],
          replaceString: news.replaceString,
        };
      }),
      update: Effect.fn(function* ({ id, news = {}, output }) {
        const hooks = Option.getOrUndefined(
          yield* Effect.serviceOption(TestResourceHooks),
        );
        if (hooks?.update) {
          yield* hooks.update(id, news);
        }
        return {
          string: news.string ?? id,
          stringArray: news.stringArray ?? [],
          stableString: id,
          stableArray: [id],
          replaceString: news.replaceString,
        };
      }),
      delete: Effect.fn(function* ({ id }) {
        const hooks = Option.getOrUndefined(
          yield* Effect.serviceOption(TestResourceHooks),
        );
        if (hooks?.delete) {
          yield* hooks.delete(id);
        }
        return;
      }),
    };
  }),
);

// StaticStablesResource - A test resource that has static stables on the provider
// This simulates resources like VPC, Subnet, etc. where certain properties (e.g., vpcId, subnetId)
// are always stable and defined on the provider itself, not returned dynamically by diff()

export type StaticStablesResourceProps = {
  string?: string;
  tags?: Record<string, string>;
  replaceString?: string;
};

export interface StaticStablesResource extends Resource<
  "Test.StaticStablesResource",
  StaticStablesResourceProps,
  {
    string: string;
    tags: Record<string, string>;
    stableId: string;
    stableArn: string;
    replaceString: StaticStablesResourceProps["replaceString"];
  }
> {}

export class StaticStablesResourceHooks extends ServiceMap.Service<
  StaticStablesResourceHooks,
  {
    create?: (
      id: string,
      props: StaticStablesResourceProps,
    ) => Effect.Effect<void, any>;
    update?: (
      id: string,
      props: StaticStablesResourceProps,
    ) => Effect.Effect<void, any>;
    delete?: (id: string) => Effect.Effect<void, any>;
  }
>()("StaticStablesResourceHooks") {}

export const StaticStablesResource = Resource<StaticStablesResource>(
  "Test.StaticStablesResource",
);

export const staticStablesResourceProvider =
  StaticStablesResource.provider.succeed({
    // KEY DIFFERENCE: Static stables defined on the provider itself
    // These are always stable regardless of what diff() returns
    stables: ["stableId", "stableArn"],
    diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
      // Replace when replaceString changes
      if (news.replaceString !== olds.replaceString) {
        return { action: "replace" };
      }
      // For string changes, return update action
      if (news.string !== olds.string) {
        return { action: "update" };
      }
      // For tag-only changes, return undefined (no action)
      // This simulates the VPC bug: tags changed, arePropsChanged returns true,
      // but diff() returns undefined because provider doesn't explicitly handle tags
      return undefined;
    }),
    create: Effect.fn(function* ({ id, news = {} }) {
      const hooks = Option.getOrUndefined(
        yield* Effect.serviceOption(StaticStablesResourceHooks),
      );
      if (hooks?.create) {
        yield* hooks.create(id, news);
      }
      return {
        string: news.string ?? id,
        tags: news.tags ?? {},
        stableId: `stable-${id}`,
        stableArn: `arn:test:resource:us-east-1:123456789:${id}`,
        replaceString: news.replaceString,
      };
    }),
    update: Effect.fn(function* ({ id, news = {}, output }) {
      const hooks = Option.getOrUndefined(
        yield* Effect.serviceOption(StaticStablesResourceHooks),
      );
      if (hooks?.update) {
        yield* hooks.update(id, news);
      }
      return {
        string: news.string ?? id,
        tags: news.tags ?? {},
        stableId: output.stableId,
        stableArn: output.stableArn,
        replaceString: news.replaceString,
      };
    }),
    delete: Effect.fn(function* ({ id, output }) {
      yield* Effect.logDebug(output.string);
      const hooks = Option.getOrUndefined(
        yield* Effect.serviceOption(StaticStablesResourceHooks),
      );
      if (hooks?.delete) {
        yield* hooks.delete(id);
      }
      return;
    }),
  });

// Layers
export const TestLayers = Layer.mergeAll(
  bucketProvider,
  queueProvider,
  functionProvider,
  bindingTargetProvider,
  deletedBindingRegressionProvider,
  testResourceProvider,
  staticStablesResourceProvider,
);

export const InMemoryTestLayers = () =>
  Layer.mergeAll(TestLayers, State.InMemory());
