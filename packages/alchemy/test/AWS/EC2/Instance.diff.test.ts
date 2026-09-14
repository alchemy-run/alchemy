import * as AWS from "@/AWS";
import { Instance, type InstanceProps } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const props = (overrides: Partial<InstanceProps> = {}): InstanceProps => ({
  imageId: "ami-0123456789abcdef0",
  instanceType: "t3.micro",
  subnetId: "subnet-0123456789abcdef0",
  ...overrides,
});

const diff = (olds: InstanceProps, news: InstanceProps) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Instance);
    return yield* provider.diff!({
      id: "Instance",
      fqn: "Instance",
      instanceId: "instance",
      olds,
      news,
      oldBindings: [],
      newBindings: [],
      output: undefined,
    });
  });

test.provider(
  "replaces delete-first when an explicit private IP cannot coexist",
  () =>
    Effect.gen(function* () {
      const olds = props({
        privateIpAddress: "10.0.1.10",
        userData: "generation-one",
      });
      const news = props({
        privateIpAddress: "10.0.1.10",
        userData: "generation-two",
      });

      expect(yield* diff(olds, news)).toEqual({
        action: "replace",
        deleteFirst: true,
      });
    }),
);

test.provider(
  "keeps create-first replacement when no fixed private IP is requested",
  () =>
    Effect.gen(function* () {
      const olds = props({ userData: "generation-one" });
      const news = props({ userData: "generation-two" });

      expect(yield* diff(olds, news)).toEqual({ action: "replace" });
    }),
);

test.provider(
  "keeps create-first replacement when the fixed private IP changes",
  () =>
    Effect.gen(function* () {
      const olds = props({ privateIpAddress: "10.0.1.10" });
      const news = props({ privateIpAddress: "10.0.1.11" });

      expect(yield* diff(olds, news)).toEqual({ action: "replace" });
    }),
);

test.provider("preserves update and no-op decisions", () =>
  Effect.gen(function* () {
    const unchanged = props({ privateIpAddress: "10.0.1.10" });
    expect(yield* diff(unchanged, unchanged)).toBeUndefined();

    expect(
      yield* diff(unchanged, {
        ...unchanged,
        instanceType: "t3.small",
      }),
    ).toEqual({
      action: "update",
      stables: ["instanceId", "instanceArn", "vpcId", "subnetId"],
    });
  }),
);
