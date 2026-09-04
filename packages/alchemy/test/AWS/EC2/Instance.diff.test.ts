import * as AWS from "@/AWS";
import { Instance, type InstanceProps } from "@/AWS/EC2";
import * as Output from "@/Output.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const baseProps = {
  imageId: "ami-0123456789abcdef0",
  instanceType: "t3.micro",
  userData: "#!/bin/bash\necho generation-one\n",
} satisfies InstanceProps;

const callDiff = (news: InstanceProps, olds: InstanceProps = baseProps) =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(Instance);
    return yield* provider.diff!({
      id: "AppInstance",
      fqn: "AppInstance",
      instanceId: "instance",
      olds,
      news,
      oldBindings: [],
      newBindings: [],
      output: undefined,
    });
  });

test.provider("resolved userData change plans a replacement", () =>
  Effect.gen(function* () {
    const diff = yield* callDiff({
      ...baseProps,
      userData: "#!/bin/bash\necho generation-two\n",
    });
    expect(diff).toEqual({ action: "replace" });
  }),
);

test.provider("unresolved userData plans a replacement", () =>
  Effect.gen(function* () {
    // Plan-time shape of `userData` that interpolates upstream outputs
    // (ECR.Image.imageUri, S3.Bucket.bucketName) while those upstreams
    // are still updating/replacing: the engine cannot materialize the
    // string, so `news.userData` arrives as an Output expr. Before the
    // fix, `isResolved(news)` bailed and the engine defaulted to update
    // — keeping the same stopped instance ID and never re-running user
    // data.
    const userData = Output.interpolate`#!/bin/bash
docker pull ${Output.literal("123.dkr.ecr.us-east-1.amazonaws.com/app:newhash")}
aws s3 cp s3://${Output.literal("my-bucket")}/app.tgz /tmp/
`;
    const diff = yield* callDiff({
      ...baseProps,
      userData: userData as never,
    });
    expect(diff).toEqual({ action: "replace" });
  }),
);

test.provider("unresolved imageId plans a replacement", () =>
  Effect.gen(function* () {
    const diff = yield* callDiff({
      ...baseProps,
      imageId: Output.literal("ami-0new") as never,
    });
    expect(diff).toEqual({ action: "replace" });
  }),
);

test.provider("unchanged resolved launch config is not a replacement", () =>
  Effect.gen(function* () {
    const diff = yield* callDiff(baseProps);
    expect(diff).toBeUndefined();
  }),
);

test.provider("unresolved update-only props do not force replacement", () =>
  Effect.gen(function* () {
    const diff = yield* callDiff({
      ...baseProps,
      tags: { Name: Output.literal("app") as never },
    });
    expect(diff).toBeUndefined();
  }),
);

test.provider("resolved instanceType change plans an in-place update", () =>
  Effect.gen(function* () {
    const diff = yield* callDiff({
      ...baseProps,
      instanceType: "t3.small",
    });
    expect(diff).toEqual({
      action: "update",
      stables: ["instanceId", "instanceArn", "vpcId", "subnetId"],
    });
  }),
);
