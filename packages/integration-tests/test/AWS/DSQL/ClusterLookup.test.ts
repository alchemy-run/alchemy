import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dsql from "@distilled.cloud/aws/dsql";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:dsql", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "DsqlLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const cluster = yield* AWS.DSQL.Cluster("lookup-target");
    return {
      clusterId: cluster.clusterId.as<string>(),
      clusterArn: cluster.clusterArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up cluster resolves by id, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { clusterId, clusterArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return { arn: AWS.DSQL.Cluster.lookup({ clusterId }).clusterArn };
        },
        {
          arn: clusterArn,
        },
      );
      const survivor = yield* dsql.getCluster({ identifier: clusterId });
      expect(survivor.arn).toBe(clusterArn);
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a lookup of a missing cluster fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-cluster": AWS.DSQL.Cluster.lookup({ clusterId: "aaaaaaaaaaaaaaaaaaaaaaaaaa" })
          .clusterArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 300_000 },
);
