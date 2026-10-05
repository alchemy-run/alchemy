import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datamigration from "@distilled.cloud/azure/datamigration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (resourceGroupName: string, migrationServiceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datamigration.GetMigrationService({
      subscriptionId,
      resourceGroupName,
      migrationServiceName,
    });
  });

const serviceGone = (resourceGroupName: string, name: string) =>
  getService(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["NotFound", "ResourceNotFound", "ResourceGroupNotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: { location?: string; tags?: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const service = yield* Azure.DataMigration.MigrationService("Service", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, service };
  });

// The migration service resource is free ($0/h); provisioning takes
// about a minute.
test.provider(
  "create, update tags, replace, and delete a migration service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        program({ tags: { env: "dev" } }),
      );
      const rg = group.resourceGroupName;
      expect(service.provisioningState).toEqual("Succeeded");
      expect(service.migrationServiceId).toContain("/migrationServices/");
      expect(service.tags).toEqual({ env: "dev" });
      const observed = yield* getService(rg, service.migrationServiceName);
      expect(observed.tags?.env).toEqual("dev");

      // In-place tag update.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.service.migrationServiceName).toEqual(
        service.migrationServiceName,
      );
      const reobserved = yield* getService(rg, service.migrationServiceName);
      expect(reobserved.tags?.env).toEqual("prod");

      // Location change replaces the service.
      const replaced = yield* stack.deploy(
        program({ location: "eastus2", tags: { env: "prod" } }),
      );
      expect(replaced.service.migrationServiceName).not.toEqual(
        service.migrationServiceName,
      );
      expect(replaced.service.location).toEqual("eastus2");
      expect(yield* serviceGone(rg, service.migrationServiceName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* serviceGone(rg, replaced.service.migrationServiceName),
      ).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:datamigration", "live"],
    timeout: 900_000,
  },
);
