import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { labFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRunner = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetServiceRunner({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

const program = (props: {
  identity: "First" | "Second";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture();
    // Both identities stay deployed across the replacement step.
    const first = yield* Azure.ManagedIdentity.UserAssignedIdentity("First", {
      resourceGroup: group.resourceGroupName,
    });
    const second = yield* Azure.ManagedIdentity.UserAssignedIdentity("Second", {
      resourceGroup: group.resourceGroupName,
    });
    const identity = props.identity === "First" ? first : second;
    const runner = yield* Azure.DevTestLabs.ServiceRunner("Runner", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      identityId: identity.identityId,
      tags: props.tags,
    });
    return { group, lab, identity, runner };
  });

// Free lab + identities; ~5 minutes for the lab.
test.provider(
  "create, update, replace, and delete a service runner",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, identity, runner } = yield* stack.deploy(
        program({ identity: "First", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getRunner(group.resourceGroupName, lab.labName, name);
      const observed = yield* get(runner.serviceRunnerName);
      expect(
        Object.keys(observed.identity?.userAssignedIdentities ?? {}).map((k) =>
          k.toLowerCase(),
        ),
      ).toEqual([identity.identityId.toLowerCase()]);
      expect(observed.tags?.env).toEqual("test");

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ identity: "First", tags: { env: "prod" } }),
      );
      expect(updated.runner.serviceRunnerId).toEqual(runner.serviceRunnerId);
      expect((yield* get(runner.serviceRunnerName)).tags?.env).toEqual("prod");

      // Replacement: a different identity.
      const replaced = yield* stack.deploy(
        program({ identity: "Second", tags: { env: "prod" } }),
      );
      expect(replaced.runner.identityId.toLowerCase()).toEqual(
        replaced.identity.identityId.toLowerCase(),
      );
      expect(
        Object.keys(
          (yield* get(replaced.runner.serviceRunnerName)).identity
            ?.userAssignedIdentities ?? {},
        ).map((k) => k.toLowerCase()),
      ).toEqual([replaced.identity.identityId.toLowerCase()]);

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.runner.serviceRunnerName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
