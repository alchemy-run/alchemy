import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:lambda", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "LayerLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const layer = yield* AWS.Lambda.LayerVersion("lookup-target", {
      path: fileURLToPath(new URL("./fixtures/layer-v1", import.meta.url)),
    });
    return {
      layerName: layer.layerName.as<string>(),
      layerVersionArn: layer.layerVersionArn.as<string>(),
      version: layer.version.as<number>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up layer resolves its latest version and a pinned one, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { layerName, layerVersionArn, version } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const latest = AWS.Lambda.LayerVersion.lookup({ layerName });
          const pinned = AWS.Lambda.LayerVersion.lookup({ layerName, version });
          return { latest: latest.layerVersionArn, pinned: pinned.layerVersionArn };
        },
        {
          latest: layerVersionArn,
          pinned: layerVersionArn,
        },
      );
      const survivor = yield* lambda.getLayerVersionByArn({ Arn: layerVersionArn });
      expect(survivor.LayerVersionArn).toBe(layerVersionArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing layer version fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-layer-version", {
            value: AWS.Lambda.LayerVersion.lookup({ layerName: name }).layerVersionArn,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a layer version this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.Lambda.LayerVersion("lookup-managed", {
          path: fileURLToPath(new URL("./fixtures/layer-v1", import.meta.url)),
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-layer-version-consumer", {
              value: AWS.Lambda.LayerVersion.lookup({ layerName: attrs.layerName }).layerVersionArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
