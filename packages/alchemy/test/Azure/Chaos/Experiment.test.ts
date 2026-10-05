import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as chaos from "@distilled.cloud/azure/chaos";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getExperiment = (resourceGroupName: string, experimentName: string) =>
  Effect.gen(function* () {
    return yield* chaos.GetExperiment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      experimentName,
    });
  });

const program = (props: {
  location: string;
  duration: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const nsg = yield* Azure.Network.NetworkSecurityGroup("Nsg", {
      resourceGroup: group.resourceGroupName,
    });
    const target = yield* Azure.Chaos.Target("Target", {
      parentResourceId: nsg.networkSecurityGroupId,
      targetType: "Microsoft-NetworkSecurityGroup",
    });
    const capability = yield* Azure.Chaos.Capability("SecurityRule", {
      targetId: target.targetId,
      capabilityType: "SecurityRule-1.1",
    });
    const experiment = yield* Azure.Chaos.Experiment("Experiment", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
      selectors: [
        { type: "List", id: "nsgs", targets: [{ id: target.targetId }] },
      ],
      steps: [
        {
          name: "step1",
          branches: [
            {
              name: "branch1",
              actions: [
                {
                  type: "continuous",
                  name: capability.urn,
                  duration: props.duration,
                  selectorId: "nsgs",
                  parameters: [
                    { key: "name", value: "AlchemyBlockInbound" },
                    { key: "protocol", value: "Any" },
                    { key: "sourceAddresses", value: '["*"]' },
                    { key: "destinationAddresses", value: '["*"]' },
                    { key: "destinationPortRanges", value: '["*"]' },
                    { key: "sourcePortRanges", value: '["*"]' },
                    { key: "action", value: "Deny" },
                    { key: "direction", value: "Inbound" },
                    { key: "priority", value: "100" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    return { group, target, experiment };
  });

const actionOf = (observed: chaos.GetExperimentResponse) =>
  observed.properties.steps[0]?.branches[0]?.actions[0];

// Experiments are free unless started (the test never starts one);
// provisions in ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a chaos experiment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, target, experiment } = yield* stack.deploy(
        program({
          location: "eastus",
          duration: "PT5M",
          tags: { env: "a" },
        }),
      );
      const get = (name: string) =>
        getExperiment(group.resourceGroupName, name);
      expect(experiment.provisioningState).toEqual("Succeeded");
      expect(experiment.identityType).toEqual("SystemAssigned");
      expect(experiment.principalId).not.toEqual("");
      expect(experiment.tags).toEqual({ env: "a" });
      const observed = yield* get(experiment.experimentName);
      expect(actionOf(observed)?.duration).toEqual("PT5M");
      expect(actionOf(observed)?.parameters?.length).toEqual(9);
      expect(
        observed.properties.selectors[0]?.targets?.[0]?.id.toLowerCase(),
      ).toEqual(target.targetId.toLowerCase());
      expect(observed.tags?.env).toEqual("a");

      // In place: definition and tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          duration: "PT10M",
          tags: { env: "b" },
        }),
      );
      expect(updated.experiment.experimentId).toEqual(experiment.experimentId);
      const reobserved = yield* get(experiment.experimentName);
      expect(actionOf(reobserved)?.duration).toEqual("PT10M");
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus",
          duration: "PT10M",
          tags: { env: "b" },
        }),
      );
      const next = replaced.experiment.experimentName;
      expect(next).not.toEqual(experiment.experimentName);
      expect(replaced.experiment.location).toEqual("westus");
      expect((yield* get(next)).properties.provisioningState).toEqual(
        "Succeeded",
      );
      expect(yield* waitGone(get(experiment.experimentName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(next))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
