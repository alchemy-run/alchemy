import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  location: string;
  publicNetworkAccess?: "Enabled" | "Disabled";
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const hub = yield* Azure.Migrate.MigrateProject("Hub", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, hub };
  });

const getProject = (resourceGroupName: string, migrateProjectName: string) =>
  Effect.gen(function* () {
    return yield* migrate.MigrateProjectsControllerGetMigrateProject({
      subscriptionId: yield* subscription,
      resourceGroupName,
      migrateProjectName,
    });
  });

// Free control-plane object; under a minute.
test.provider(
  "create, update, replace, and delete a Migrate project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub } = yield* stack.deploy(program({ location, tags: { env: "test" } }));
      const get = (name: string) => getProject(group.resourceGroupName, name);
      expect(hub.location).toEqual(location);
      expect(hub.migrateProjectId.toLowerCase()).toContain(
        `/providers/microsoft.migrate/migrateprojects/${hub.migrateProjectName.toLowerCase()}`,
      );
      expect(hub.publicNetworkAccess).toEqual("Enabled");
      const observed = yield* get(hub.migrateProjectName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Hub");

      // In place: tags and public network access.
      const updated = yield* stack.deploy(
        program({ location, publicNetworkAccess: "Disabled", tags: { env: "prod", team: "m" } }),
      );
      expect(updated.hub.migrateProjectId).toEqual(hub.migrateProjectId);
      expect(updated.hub.tags).toEqual({ env: "prod", team: "m" });
      expect(updated.hub.publicNetworkAccess).toEqual("Disabled");
      const reobserved = yield* get(hub.migrateProjectName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.team).toEqual("m");
      expect(reobserved.tags?.["alchemy::id"]).toEqual("Hub");
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(program({ location: "westus2", tags: { env: "prod" } }));
      expect(replaced.hub.location).toEqual("westus2");
      expect(replaced.hub.migrateProjectName).not.toEqual(hub.migrateProjectName);
      expect(yield* waitGone(get(hub.migrateProjectName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.hub.migrateProjectName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
