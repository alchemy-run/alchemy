import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as loadtestservice from "@distilled.cloud/azure/loadtestservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getLoadTest = (resourceGroupName: string, loadTestName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* loadtestservice.GetLoadTest({
      subscriptionId,
      resourceGroupName,
      loadTestName,
    });
  });

const loadTestGone = (resourceGroupName: string, loadTestName: string) =>
  getLoadTest(resourceGroupName, loadTestName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  name?: string;
  description: string;
  identity?: Azure.LoadTesting.LoadTestIdentity;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const load = yield* Azure.LoadTesting.LoadTest("Load", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      description: props.description,
      identity: props.identity,
      tags: props.tags,
    });
    return { group, load };
  });

// Idle load test resources are free (billing is per virtual-user hour of
// test runs); create/update/delete takes ~2-4 minutes.
test.provider(
  "create, update, replace, and delete a load test resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ description: "first", tags: { env: "test" } }),
      );
      const { group, load } = created;
      expect(load.provisioningState).toEqual("Succeeded");
      expect(load.dataPlaneUri).toContain("loadtesting.azure.com");
      expect(load.principalId).toBeUndefined();
      const observed = yield* getLoadTest(
        group.resourceGroupName,
        load.loadTestName,
      );
      expect(observed.properties?.description).toEqual("first");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Load");

      // In place: description, system-assigned identity, tags.
      const updated = yield* stack.deploy(
        program({
          description: "second",
          identity: { type: "SystemAssigned" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.load.loadTestId).toEqual(load.loadTestId);
      expect(updated.load.principalId).toBeDefined();
      const reobserved = yield* getLoadTest(
        group.resourceGroupName,
        load.loadTestName,
      );
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.identity?.type).toEqual("SystemAssigned");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name creates a new resource and deletes the old.
      const replacementName = `${load.loadTestName.slice(0, 50)}-r`;
      const replaced = yield* stack.deploy(
        program({
          name: replacementName,
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.load.loadTestName).toEqual(replacementName);
      expect(replaced.load.loadTestId).not.toEqual(load.loadTestId);
      expect(
        yield* loadTestGone(group.resourceGroupName, load.loadTestName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* loadTestGone(group.resourceGroupName, replacementName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:loadtesting", "live"],
    timeout: 900_000,
  },
);
