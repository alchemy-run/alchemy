import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { getPipeline, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  remoteCloud: string;
  displayName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const pipeline = yield* Azure.DataTransfer.Pipeline("Pipeline", {
      resourceGroup: group.resourceGroupName,
      remoteCloud: props.remoteCloud,
      displayName: props.displayName,
      tags: props.tags,
    });
    return { group, pipeline };
  });

// Pipelines can only be created by subscriptions onboarded to Azure Data
// Transfer (the free trial is rejected with DataTransferPipelineNotAllowed).
// The pipeline itself is free; billing is per transferred GB.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a pipeline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, pipeline } = yield* stack.deploy(
        program({
          remoteCloud: "Public",
          displayName: "first",
          tags: { env: "test" },
        }),
      );
      const get = (name: string) => getPipeline(group.resourceGroupName, name);
      const observed = yield* get(pipeline.pipelineName);
      expect(observed.properties?.remoteCloud).toEqual("Public");
      expect(observed.properties?.displayName).toEqual("first");
      expect(observed.tags?.env).toEqual("test");

      // In place: display name and tags.
      const updated = yield* stack.deploy(
        program({
          remoteCloud: "Public",
          displayName: "second",
          tags: { env: "prod" },
        }),
      );
      expect(updated.pipeline.pipelineId).toEqual(pipeline.pipelineId);
      const reobserved = yield* get(pipeline.pipelineName);
      expect(reobserved.properties?.displayName).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the remote cloud is immutable.
      const replaced = yield* stack.deploy(
        program({
          remoteCloud: "Government",
          displayName: "second",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.pipeline.pipelineName).not.toEqual(pipeline.pipelineName);
      expect(replaced.pipeline.remoteCloud).toEqual("Government");
      expect(yield* waitGone(get(pipeline.pipelineName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.pipeline.pipelineName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free): a subscription that is not onboarded to Azure Data
// Transfer cannot create pipelines.
test.provider(
  "a subscription not onboarded to Data Transfer cannot create pipelines",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          program({ remoteCloud: "Public", displayName: "probe", tags: {} }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(error)).toContain("DataTransferPipelineNotAllowed");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
