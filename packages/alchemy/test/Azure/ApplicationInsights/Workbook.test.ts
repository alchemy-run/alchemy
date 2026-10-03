import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as applicationinsights from "@distilled.cloud/azure/applicationinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getWorkbook = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* applicationinsights.GetWorkbook({
      subscriptionId,
      resourceGroupName,
      resourceName,
      canFetchContent: true,
    });
  });

const workbookGone = (resourceGroupName: string, resourceName: string) =>
  getWorkbook(resourceGroupName, resourceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  displayName: string;
  tags: Record<string, string>;
  heading: string;
  linkToGroup: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workbook = yield* Azure.ApplicationInsights.Workbook("Report", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      displayName: props.displayName,
      description: "alchemy workbook test",
      sourceId: props.linkToGroup ? group.resourceGroupId : undefined,
      labels: ["alchemy"],
      serializedData: {
        version: "Notebook/1.0",
        items: [
          {
            type: 1,
            content: { json: `## ${props.heading}` },
            name: "title",
          },
        ],
      },
      tags: props.tags,
    });
    return { group, workbook };
  });

test.provider(
  "create, update, replace, and delete a workbook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          displayName: "Alchemy Report",
          tags: { env: "test" },
          heading: "First",
          linkToGroup: false,
        }),
      );
      const { group, workbook } = created;
      expect(workbook.workbookName).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(workbook.displayName).toEqual("Alchemy Report");
      expect(workbook.category).toEqual("workbook");
      expect(workbook.sourceId.toLowerCase()).toEqual("azure monitor");
      expect(workbook.tags).toEqual({ env: "test" });

      const observed = yield* getWorkbook(
        group.resourceGroupName,
        workbook.workbookName,
      );
      expect(observed.kind).toEqual("shared");
      expect(observed.properties?.displayName).toEqual("Alchemy Report");
      expect(observed.properties?.serializedData).toContain("## First");
      expect(observed.properties?.tags).toEqual(["alchemy"]);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Report");
      expect(observed.tags?.["hidden-title"]).toEqual("Alchemy Report");

      // Redeploying unchanged props must not rewrite the definition.
      yield* stack.deploy(
        program({
          displayName: "Alchemy Report",
          tags: { env: "test" },
          heading: "First",
          linkToGroup: false,
        }),
      );
      const unchanged = yield* getWorkbook(
        group.resourceGroupName,
        workbook.workbookName,
      );
      expect(unchanged.properties?.timeModified).toEqual(
        observed.properties?.timeModified,
      );

      // In-place update: display name, definition and tags.
      const updated = yield* stack.deploy(
        program({
          displayName: "Alchemy Report v2",
          tags: { env: "prod" },
          heading: "Second",
          linkToGroup: false,
        }),
      );
      expect(updated.workbook.workbookName).toEqual(workbook.workbookName);
      const reobserved = yield* getWorkbook(
        group.resourceGroupName,
        workbook.workbookName,
      );
      expect(reobserved.properties?.displayName).toEqual("Alchemy Report v2");
      expect(reobserved.properties?.serializedData).toContain("## Second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: linking to another source creates a new workbook.
      const replaced = yield* stack.deploy(
        program({
          displayName: "Alchemy Report v2",
          tags: { env: "prod" },
          heading: "Second",
          linkToGroup: true,
        }),
      );
      expect(replaced.workbook.workbookName).not.toEqual(workbook.workbookName);
      expect(replaced.workbook.sourceId.toLowerCase()).toEqual(
        group.resourceGroupId.toLowerCase(),
      );
      expect(
        yield* workbookGone(group.resourceGroupName, workbook.workbookName),
      ).toEqual("gone");
      const linked = yield* getWorkbook(
        group.resourceGroupName,
        replaced.workbook.workbookName,
      );
      expect(linked.properties?.sourceId?.toLowerCase()).toEqual(
        group.resourceGroupId.toLowerCase(),
      );

      yield* stack.destroy();
      expect(
        yield* workbookGone(
          group.resourceGroupName,
          replaced.workbook.workbookName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:applicationinsights", "live"],
    timeout: 600_000,
  },
);
