import type { Input, InputProps } from "@/input";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { Resource } from "@/resource";
import { isUnknown } from "@/unknown";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderService } from "@/provider";
import * as State from "@/state";

// Bucket
export type BucketProps = {
  name?: string;
};

export type BucketAttr<Props extends BucketProps> = {
  name: Props["name"] extends string ? Props["name"] : string;
};

export interface Bucket<
  ID extends string = string,
  Props extends BucketProps = BucketProps,
> extends Resource<"Test.Bucket", ID, Props, BucketAttr<Props>, Bucket> {}

export const Bucket = Resource<{
  <const ID extends string, const Props extends Input<BucketProps>>(
    id: ID,
    props?: Props,
  ): Bucket<ID, Input.Resolve<Props>>;
}>("Test.Bucket");

const bucketProvider = Bucket.provider.succeed({
  diff: Effect.fn(function* ({ id, news, output }) {}),
  create: Effect.fn(function* ({ id, news }) {
    return {
      name: news.name ?? id,
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

export type QueueAttr<Props extends QueueProps> = {
  name: Props["name"] extends string ? Props["name"] : string;
  queueUrl: string;
};

export interface Queue<
  ID extends string = string,
  Props extends QueueProps = QueueProps,
> extends Resource<"Test.Queue", ID, Props, QueueAttr<Props>, Queue> {}

export const Queue = Resource<{
  <const ID extends string, const Props extends Input<QueueProps>>(
    id: ID,
    props?: Props,
  ): Queue<ID, Input.Resolve<Props>>;
}>("Test.Queue");

export const queueProvider = Queue.provider.succeed({
  diff: Effect.fn(function* ({ id, news, output }) {}),
  create: Effect.fn(function* ({ id, news }) {
    const name = news.name ?? id;
    return {
      name,
      queueUrl: `https://test.queue.com/${name}`,
    };
  }),
  update: Effect.fn(function* ({ id, news, output }) {
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

export type FunctionAttr<Props extends FunctionProps> = {
  name: Props["name"] extends string ? Props["name"] : string;
};

export interface Function<
  ID extends string = string,
  Props extends InputProps<FunctionProps> = InputProps<FunctionProps>,
> extends Resource<
    "Test.Function",
    ID,
    Props,
    FunctionAttr<Input.Resolve<Props>>,
    Function
  > {}

export const Function = Resource<{
  <const ID extends string, const Props extends InputProps<FunctionProps>>(
    id: ID,
    props?: Props,
  ): Function<ID, Props>;
}>("Test.Function");

export const functionProvider = Function.provider.succeed({
  diff: Effect.fn(function* ({ id, news, output }) {}),
  create: Effect.fn(function* ({ id, news }) {
    return {
      name: news.name ?? id,
      env: news.env ?? {},
      functionArn: `arn:aws:lambda:us-west-2:084828582823:function:${id}`,
    };
  }),
  update: Effect.fn(function* ({ id, news, output }) {
    return {
      name: news.name ?? id,
      env: news.env ?? {},
      functionArn: `arn:aws:lambda:us-west-2:084828582823:function:${id}`,
    };
  }),
  delete: Effect.fn(function* ({ output }) {}),
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

export type TestResourceAttr<Props extends TestResourceProps> = {
  string: Props["string"] extends string ? Props["string"] : string;
  stringArray: Props["stringArray"] extends string[]
    ? Props["stringArray"]
    : string[];
  stableString: string;
  stableArray: string[];
  replaceString: Props["replaceString"];
};

export interface TestResource<
  ID extends string = string,
  Props extends InputProps<TestResourceProps> = InputProps<TestResourceProps>,
> extends Resource<
    "Test.TestResource",
    ID,
    Props,
    TestResourceAttr<Input.Resolve<Props>>,
    TestResource
  > {}

export class TestResourceHooks extends Context.Tag("TestResourceHooks")<
  TestResourceHooks,
  {
    create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    delete?: (id: string) => Effect.Effect<void, any>;
  }
>() {}

export const TestResource = Resource<{
  <const ID extends string, const Props extends InputProps<TestResourceProps>>(
    id: ID,
    props?: Props,
  ): TestResource<ID, Props>;
}>("Test.TestResource");

export const testResourceProvider = TestResource.provider.effect(
  Effect.gen(function* () {
    return {
      diff: Effect.fn(function* ({ id, news, olds }) {
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
      create: Effect.fn(function* ({ id, news }) {
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
      update: Effect.fn(function* ({ id, news, output }) {
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

export type StaticStablesResourceAttr<
  Props extends StaticStablesResourceProps,
> = {
  string: Props["string"] extends string ? Props["string"] : string;
  tags: Props["tags"] extends Record<string, string>
    ? Props["tags"]
    : Record<string, string>;
  stableId: string;
  stableArn: string;
  replaceString: Props["replaceString"];
};

export interface StaticStablesResource<
  ID extends string = string,
  Props extends
    InputProps<StaticStablesResourceProps> = InputProps<StaticStablesResourceProps>,
> extends Resource<
    "Test.StaticStablesResource",
    ID,
    Props,
    StaticStablesResourceAttr<Input.Resolve<Props>>,
    StaticStablesResource
  > {}

export class StaticStablesResourceHooks extends Context.Tag(
  "StaticStablesResourceHooks",
)<
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
>() {}

export const StaticStablesResource = Resource<{
  <
    const ID extends string,
    const Props extends InputProps<StaticStablesResourceProps>,
  >(
    id: ID,
    props?: Props,
  ): StaticStablesResource<ID, Props>;
}>("Test.StaticStablesResource");

export const staticStablesResourceProvider =
  StaticStablesResource.provider.effect(
    Effect.gen(function* () {
      return {
        // KEY DIFFERENCE: Static stables defined on the provider itself
        // These are always stable regardless of what diff() returns
        stables: ["stableId", "stableArn"],
        diff: Effect.fn(function* ({ id, news, olds }) {
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
        create: Effect.fn(function* ({ id, news }) {
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
        update: Effect.fn(function* ({ id, news, output }) {
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
        delete: Effect.fn(function* ({ id }) {
          const hooks = Option.getOrUndefined(
            yield* Effect.serviceOption(StaticStablesResourceHooks),
          );
          if (hooks?.delete) {
            yield* hooks.delete(id);
          }
          return;
        }),
      };
    }),
  );

// Layers
export const TestLayers = Layer.mergeAll(
  bucketProvider,
  queueProvider,
  functionProvider,
  testResourceProvider,
  staticStablesResourceProvider,
);

export const InMemoryTestLayers = () =>
  Layer.mergeAll(TestLayers, State.inMemory());
