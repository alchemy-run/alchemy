import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as databasewatcher from "@distilled.cloud/azure/databasewatcher";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getTarget = (
  resourceGroupName: string,
  watcherName: string,
  targetName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* databasewatcher.GetTarget({
      subscriptionId,
      resourceGroupName,
      watcherName,
      targetName,
    });
  });

const targetGone = (
  resourceGroupName: string,
  watcherName: string,
  targetName: string,
) =>
  getTarget(resourceGroupName, watcherName, targetName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

// The target only references a SQL database by ID; the watcher is never
// started, so no SQL resource needs to exist and the test costs nothing.
const program = (target?: { database: string; connectionServerName: string }) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const watcher = yield* Azure.DatabaseWatcher.Watcher("Watcher", {
      resourceGroup: group.resourceGroupName,
    });
    const t = target
      ? yield* Azure.DatabaseWatcher.Target("Target", {
          resourceGroup: group.resourceGroupName,
          watcher: watcher.watcherName,
          targetType: "SqlDb",
          sqlDbResourceId: Output.interpolate`/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Sql/servers/alchemy-dw-test/databases/${target.database}`,
          connectionServerName: target.connectionServerName,
        })
      : undefined;
    return { group, watcher, target: t };
  });

test.provider(
  "create, update, replace, and delete a database watcher target",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          database: "orders",
          connectionServerName: "alchemy-dw-test.database.windows.net",
        }),
      );
      const rg = created.group.resourceGroupName;
      const watcherName = created.watcher.watcherName;
      const first = created.target!;
      expect(first.targetType).toEqual("SqlDb");
      expect(first.targetAuthenticationType).toEqual("Aad");
      const observed = yield* getTarget(rg, watcherName, first.targetName);
      expect(observed.properties?.connectionServerName).toEqual(
        "alchemy-dw-test.database.windows.net",
      );
      expect(observed.properties?.sqlDbResourceId?.toLowerCase()).toContain(
        "/databases/orders",
      );

      // In-place update of the connection server name.
      const updated = yield* stack.deploy(
        program({
          database: "orders",
          connectionServerName: "alchemy-dw-test-2.database.windows.net",
        }),
      );
      expect(updated.target!.targetId).toEqual(first.targetId);
      const reobserved = yield* getTarget(rg, watcherName, first.targetName);
      expect(reobserved.properties?.connectionServerName).toEqual(
        "alchemy-dw-test-2.database.windows.net",
      );

      // Pointing at a different database replaces the target (same name,
      // delete-then-create).
      const replaced = yield* stack.deploy(
        program({
          database: "invoices",
          connectionServerName: "alchemy-dw-test-2.database.windows.net",
        }),
      );
      const replacement = yield* getTarget(
        rg,
        watcherName,
        replaced.target!.targetName,
      );
      expect(replacement.properties?.sqlDbResourceId?.toLowerCase()).toContain(
        "/databases/invoices",
      );

      // Removing the target from the stack deletes it.
      yield* stack.deploy(program());
      expect(
        yield* targetGone(rg, watcherName, replaced.target!.targetName),
      ).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:databasewatcher", "live"],
    timeout: 900_000,
  },
);
