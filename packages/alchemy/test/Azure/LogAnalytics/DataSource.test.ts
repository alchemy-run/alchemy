import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getDataSource = (
  resourceGroupName: string,
  workspaceName: string,
  dataSourceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetDataSource({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      dataSourceName,
    });
  });

const dataSourceGone = (
  resourceGroupName: string,
  workspaceName: string,
  dataSourceName: string,
) =>
  getDataSource(resourceGroupName, workspaceName, dataSourceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (source?: {
  name?: string;
  eventTypes: string[];
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
    });
    const events = source
      ? yield* Azure.LogAnalytics.DataSource("Events", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          name: source.name,
          kind: "WindowsEvent",
          properties: {
            eventLogName: "System",
            eventTypes: source.eventTypes.map((eventType) => ({ eventType })),
          },
        })
      : undefined;
    return { group, workspace, events };
  });

const eventTypesOf = (properties: unknown) =>
  (
    (properties as { eventTypes?: { eventType: string }[] }).eventTypes ?? []
  ).map((t) => t.eventType);

test.provider(
  "create, update, replace, and delete a data source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ eventTypes: ["Error"] }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      const first = created.events!;
      expect(first.kind).toEqual("WindowsEvent");
      const observed = yield* getDataSource(rg, ws, first.dataSourceName);
      expect(eventTypesOf(observed.properties)).toEqual(["Error"]);

      // In-place update of the event types.
      const updated = yield* stack.deploy(
        program({ eventTypes: ["Error", "Warning"] }),
      );
      expect(updated.events!.dataSourceName).toEqual(first.dataSourceName);
      const reobserved = yield* getDataSource(rg, ws, first.dataSourceName);
      expect(eventTypesOf(reobserved.properties)).toEqual(["Error", "Warning"]);

      // Renaming replaces the data source.
      const renamed = yield* stack.deploy(
        program({
          name: "alchemy-renamed-source",
          eventTypes: ["Error"],
        }),
      );
      expect(renamed.events!.dataSourceName).toEqual("alchemy-renamed-source");
      yield* getDataSource(rg, ws, "alchemy-renamed-source");
      expect(yield* dataSourceGone(rg, ws, first.dataSourceName)).toEqual(
        "gone",
      );

      yield* stack.deploy(program());
      expect(yield* dataSourceGone(rg, ws, "alchemy-renamed-source")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
