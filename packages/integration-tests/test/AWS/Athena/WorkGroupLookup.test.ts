import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as athena from "@distilled.cloud/aws/athena";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:athena", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "WorkGroupLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const wg = yield* AWS.Athena.WorkGroup("lookup-target");
    return {
      workGroupName: wg.workGroupName.as<string>(),
      workGroupArn: wg.workGroupArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up workgroup resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { workGroupName, workGroupArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return { arn: AWS.Athena.WorkGroup.lookup({ workGroupName }).workGroupArn };
        },
        {
          arn: workGroupArn,
        },
      );
      const survivor = yield* athena.getWorkGroup({ WorkGroup: workGroupName });
      expect(survivor.WorkGroup?.Name).toBe(workGroupName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "the primary workgroup resolves by name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { workGroupName, workGroupArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return { name: AWS.Athena.WorkGroup.lookup({ workGroupName: "primary" }).workGroupName };
        },
        {
          name: "primary",
        },
      );
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing workgroup or data catalog fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-workgroup": AWS.Athena.WorkGroup.lookup({ workGroupName: name }).workGroupArn,
        "missing-catalog": AWS.Athena.DataCatalog.lookup({ name }).dataCatalogArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a workgroup this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.Athena.WorkGroup("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-workgroup-consumer", {
              value: AWS.Athena.WorkGroup.lookup({ workGroupName: attrs.workGroupName })
                .workGroupArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
