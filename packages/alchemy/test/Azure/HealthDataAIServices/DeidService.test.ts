import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as healthdataaiservices from "@distilled.cloud/azure/healthdataaiservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getDeidService = (resourceGroupName: string, deidServiceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* healthdataaiservices.GetDeidService({
      subscriptionId,
      resourceGroupName,
      deidServiceName,
    });
  });

const deidServiceGone = (resourceGroupName: string, deidServiceName: string) =>
  getDeidService(resourceGroupName, deidServiceName).pipe(
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
  publicNetworkAccess?: "Enabled" | "Disabled";
  identity?: Azure.HealthDataAIServices.DeidServiceIdentity;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const deid = yield* Azure.HealthDataAIServices.DeidService("Deid", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, deid };
  });

// An idle de-identification service is free (billed per MB of text
// processed); create/update/delete takes ~1-3 minutes each.
test.provider(
  "create, update, replace, and delete a de-identification service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ identity: { type: "SystemAssigned" }, tags: { env: "test" } }),
      );
      const { group, deid } = created;
      expect(deid.provisioningState).toEqual("Succeeded");
      expect(deid.serviceUrl).toMatch(/^https:\/\//);
      expect(deid.principalId).toBeDefined();
      expect(deid.publicNetworkAccess).toEqual("Enabled");
      const observed = yield* getDeidService(
        group.resourceGroupName,
        deid.deidServiceName,
      );
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Deid");

      // In place: network access, identity removal, tags.
      const updated = yield* stack.deploy(
        program({ publicNetworkAccess: "Disabled", tags: { env: "prod" } }),
      );
      expect(updated.deid.deidServiceId).toEqual(deid.deidServiceId);
      expect(updated.deid.publicNetworkAccess).toEqual("Disabled");
      const reobserved = yield* getDeidService(
        group.resourceGroupName,
        deid.deidServiceName,
      );
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.identity?.type ?? "None").toEqual("None");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name creates a new service and deletes the old.
      const replacementName = `${deid.deidServiceName.slice(0, 20)}-r`;
      const replaced = yield* stack.deploy(
        program({
          name: replacementName,
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.deid.deidServiceName).toEqual(replacementName);
      expect(replaced.deid.deidServiceId).not.toEqual(deid.deidServiceId);
      expect(
        yield* deidServiceGone(group.resourceGroupName, deid.deidServiceName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* deidServiceGone(group.resourceGroupName, replacementName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:healthdataaiservices", "live"],
    timeout: 900_000,
  },
);
