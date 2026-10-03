import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as resourcegraph from "@distilled.cloud/azure/resourcegraph";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getQuery = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* resourcegraph.GetGraphQuery({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const queryGone = (resourceGroupName: string, resourceName: string) =>
  getQuery(resourceGroupName, resourceName).pipe(
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
  group: string;
  query: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup(props.group, {
      location: "eastus",
    });
    const query = yield* Azure.ResourceGraph.SharedQuery("Inventory", {
      resourceGroup: group.resourceGroupName,
      query: props.query,
      description: props.description,
      tags: props.tags,
    });
    return { group, query };
  });

test.provider(
  "create, update, replace, and delete a shared query",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          group: "Group",
          query: "Resources | project name, type | limit 1",
          description: "first",
          tags: { env: "test" },
        }),
      );
      const { group, query } = created;
      expect(query.location).toEqual("global");
      expect(query.query).toEqual("Resources | project name, type | limit 1");
      expect(query.queryId.toLowerCase()).toContain(
        "/providers/microsoft.resourcegraph/queries/",
      );
      const observed = yield* getQuery(
        group.resourceGroupName,
        query.queryName,
      );
      expect(observed.properties?.query).toEqual(
        "Resources | project name, type | limit 1",
      );
      expect(observed.properties?.description).toEqual("first");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Inventory");

      // In-place update of query text, description, and tags.
      const updated = yield* stack.deploy(
        program({
          group: "Group",
          query: "Resources | project name, location | limit 5",
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(updated.query.queryId).toEqual(query.queryId);
      const reobserved = yield* getQuery(
        group.resourceGroupName,
        query.queryName,
      );
      expect(reobserved.properties?.query).toEqual(
        "Resources | project name, location | limit 5",
      );
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: moving to another resource group. Both groups stay
      // deployed across the step (engine replace+remove deadlock).
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const oldGroup = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          const newGroup = yield* Azure.Resources.ResourceGroup("Group2", {
            location: "eastus",
          });
          const q = yield* Azure.ResourceGraph.SharedQuery("Inventory", {
            resourceGroup: newGroup.resourceGroupName,
            query: "Resources | project name, location | limit 5",
            description: "second",
            tags: { env: "prod" },
          });
          return { oldGroup, newGroup, query: q };
        }),
      );
      expect(replaced.query.resourceGroup).toEqual(
        replaced.newGroup.resourceGroupName,
      );
      expect(replaced.query.queryId).not.toEqual(query.queryId);
      expect(
        (yield* getQuery(
          replaced.newGroup.resourceGroupName,
          replaced.query.queryName,
        )).properties?.description,
      ).toEqual("second");
      expect(
        yield* queryGone(group.resourceGroupName, query.queryName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* queryGone(
          replaced.newGroup.resourceGroupName,
          replaced.query.queryName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resourcegraph", "live"],
    timeout: 900_000,
  },
);
