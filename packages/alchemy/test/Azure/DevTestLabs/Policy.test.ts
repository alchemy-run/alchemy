import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { labFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      policySetName: "default",
      name,
    });
  });

const program = (props: {
  factName: "LabVmCount" | "UserOwnedLabVmCount";
  threshold: string;
}) =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture();
    const policy = yield* Azure.DevTestLabs.Policy("VmCount", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      factName: props.factName,
      evaluatorType: "MaxValuePolicy",
      threshold: props.threshold,
      description: "cap lab VMs",
    });
    return { group, lab, policy };
  });

// Free lab + policy; ~5 minutes for the lab.
test.provider(
  "create, update, replace, and delete a lab policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, policy } = yield* stack.deploy(
        program({ factName: "LabVmCount", threshold: "2" }),
      );
      expect(policy.policyName).toEqual("LabVmCount");
      const get = (name: string) =>
        getPolicy(group.resourceGroupName, lab.labName, name);
      const observed = yield* get(policy.policyName);
      expect(observed.properties?.threshold).toEqual("2");
      expect(observed.properties?.evaluatorType).toEqual("MaxValuePolicy");
      expect(observed.tags?.["alchemy::id"]).toEqual("VmCount");

      // In-place: threshold.
      const updated = yield* stack.deploy(
        program({ factName: "LabVmCount", threshold: "3" }),
      );
      expect(updated.policy.policyId).toEqual(policy.policyId);
      expect((yield* get(policy.policyName)).properties?.threshold).toEqual("3");

      // Replacement: the fact (and so the name) changes.
      const replaced = yield* stack.deploy(
        program({ factName: "UserOwnedLabVmCount", threshold: "1" }),
      );
      expect(replaced.policy.policyName).toEqual("UserOwnedLabVmCount");
      expect(
        (yield* get("UserOwnedLabVmCount")).properties?.threshold,
      ).toEqual("1");
      expect(yield* waitGone(get("LabVmCount"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("UserOwnedLabVmCount"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
