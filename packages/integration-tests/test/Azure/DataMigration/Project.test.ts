import * as Azure from "@alchemy.run/azure";
import * as datamigration from "@distilled.cloud/azure/datamigration";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProject = (groupName: string, serviceName: string, projectName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datamigration.GetProject({
      subscriptionId,
      groupName,
      serviceName,
      projectName,
    });
  });

const getService = (groupName: string, serviceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datamigration.GetService({ subscriptionId, groupName, serviceName });
  });

const projectGone = (groupName: string, serviceName: string, projectName: string) =>
  getProject(groupName, serviceName, projectName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const serviceGone = (groupName: string, serviceName: string) =>
  getService(groupName, serviceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  sourcePlatform: "PostgreSql" | "MySQL";
  targetPlatform: "AzureDbForPostgreSql" | "AzureDbForMySql";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location: "eastus" });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      addressPrefixes: ["10.61.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Subnet", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.61.1.0/24",
    });
    const service = yield* Azure.DataMigration.ClassicMigrationService("Service", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      virtualSubnetId: subnet.subnetId,
    });
    const project = yield* Azure.DataMigration.Project("Project", {
      resourceGroup: group.resourceGroupName,
      service: service.serviceName,
      ...props,
    });
    return { group, service, project };
  });

// ~$0/run, 15-25 min: the Standard_1vCores classic service and its
// projects are free, but the classic service took more than 10 minutes to
// provision in eastus.
test.provider.skipIf(!runExpensive)(
  "create, update tags, replace, and delete a migration project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, project } = yield* stack.deploy(
        program({
          sourcePlatform: "PostgreSql",
          targetPlatform: "AzureDbForPostgreSql",
          tags: { env: "dev" },
        }),
      );
      const rg = group.resourceGroupName;
      expect(project.serviceName).toEqual(service.serviceName);
      expect(project.projectId).toContain("/projects/");
      expect(project.location).toEqual("eastus");
      expect(project.sourcePlatform).toEqual("PostgreSql");
      expect(project.targetPlatform).toEqual("AzureDbForPostgreSql");
      expect(project.tags).toEqual({ env: "dev" });
      const observed = yield* getProject(rg, service.serviceName, project.projectName);
      expect(observed.properties?.targetPlatform).toEqual("AzureDbForPostgreSql");
      expect(observed.tags?.env).toEqual("dev");

      // In-place tag update.
      const updated = yield* stack.deploy(
        program({
          sourcePlatform: "PostgreSql",
          targetPlatform: "AzureDbForPostgreSql",
          tags: { env: "prod" },
        }),
      );
      expect(updated.project.projectId).toEqual(project.projectId);
      const reobserved = yield* getProject(rg, service.serviceName, project.projectName);
      expect(reobserved.tags?.env).toEqual("prod");

      // Changing the platforms replaces the project.
      const replaced = yield* stack.deploy(
        program({
          sourcePlatform: "MySQL",
          targetPlatform: "AzureDbForMySql",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.project.projectName).not.toEqual(project.projectName);
      const replacedObserved = yield* getProject(
        rg,
        service.serviceName,
        replaced.project.projectName,
      );
      expect(replacedObserved.properties?.sourcePlatform).toEqual("MySQL");
      expect(yield* projectGone(rg, service.serviceName, project.projectName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* projectGone(rg, service.serviceName, replaced.project.projectName)).toEqual(
        "gone",
      );
      expect(yield* serviceGone(rg, service.serviceName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:datamigration", "live"],
    timeout: 3_600_000,
  },
);
