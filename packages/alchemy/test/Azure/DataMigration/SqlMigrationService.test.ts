import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datamigration from "@distilled.cloud/azure/datamigration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getService = (
  resourceGroupName: string,
  sqlMigrationServiceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datamigration.GetSqlMigrationService({
      subscriptionId,
      resourceGroupName,
      sqlMigrationServiceName,
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
    const service = yield* Azure.DataMigration.SqlMigrationService("Service", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, service };
  });

// The SQL migration service resource is free ($0/h); provisioning takes
// about a minute.
test.provider(
  "create, update tags, replace, and delete a SQL migration service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        program({ tags: { env: "dev" } }),
      );
      const rg = group.resourceGroupName;
      expect(service.provisioningState).toEqual("Succeeded");
      expect(service.sqlMigrationServiceId).toContain("/sqlMigrationServices/");
      expect(service.tags).toEqual({ env: "dev" });
      expect(service.authKey1).toBeDefined();
      expect(Redacted.value(service.authKey1!).length).toBeGreaterThan(0);
      const observed = yield* getService(rg, service.sqlMigrationServiceName);
      expect(observed.tags?.env).toEqual("dev");
      expect(observed.properties?.integrationRuntimeState).toEqual(
        "NeedRegistration",
      );

      // In-place tag update.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.service.sqlMigrationServiceName).toEqual(
        service.sqlMigrationServiceName,
      );
      const reobserved = yield* getService(rg, service.sqlMigrationServiceName);
      expect(reobserved.tags?.env).toEqual("prod");

      // Location change replaces the service.
      const replaced = yield* stack.deploy(
        program({ location: "eastus2", tags: { env: "prod" } }),
      );
      expect(replaced.service.sqlMigrationServiceName).not.toEqual(
        service.sqlMigrationServiceName,
      );
      expect(replaced.service.location).toEqual("eastus2");
      expect(yield* serviceGone(rg, service.sqlMigrationServiceName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* serviceGone(rg, replaced.service.sqlMigrationServiceName),
      ).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:datamigration", "live"],
    timeout: 900_000,
  },
);
