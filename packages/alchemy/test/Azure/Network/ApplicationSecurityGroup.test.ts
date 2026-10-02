import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  applicationSecurityGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetApplicationSecurityGroup({
      subscriptionId,
      resourceGroupName,
      applicationSecurityGroupName,
    }),
  );

// Application security groups are free.
const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const asg = yield* Azure.Network.ApplicationSecurityGroup("Web", {
      resourceGroup: group.resourceGroupName,
      tags: props.tags,
    });
    return { group, asg };
  });

test.provider(
  "create, update, and delete an application security group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, asg } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(asg.location).toEqual("eastus");
      expect(asg.applicationSecurityGroupId).toMatch(
        /\/providers\/Microsoft\.Network\/applicationSecurityGroups\//,
      );
      const observed = yield* getGroup(
        group.resourceGroupName,
        asg.applicationSecurityGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Web");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.asg.applicationSecurityGroupId).toEqual(
        asg.applicationSecurityGroupId,
      );
      expect(updated.asg.tags).toEqual({ env: "prod" });
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        asg.applicationSecurityGroupName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGroup(group.resourceGroupName, asg.applicationSecurityGroupName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
