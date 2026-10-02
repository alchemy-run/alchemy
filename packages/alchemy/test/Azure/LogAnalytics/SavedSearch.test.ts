import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getSearch = (
  resourceGroupName: string,
  workspaceName: string,
  savedSearchId: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetSavedSearch({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      savedSearchId,
    });
  });

const searchGone = (
  resourceGroupName: string,
  workspaceName: string,
  savedSearchId: string,
) =>
  getSearch(resourceGroupName, workspaceName, savedSearchId).pipe(
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

const program = (search?: {
  name?: string;
  alias?: string;
  query: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
    });
    const fn = search
      ? yield* Azure.LogAnalytics.SavedSearch("Fn", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          name: search.name,
          category: "Alchemy",
          displayName: "Alchemy function",
          // Aliases are unique per workspace; a create-first replacement needs a new one.
          functionAlias: search.alias ?? "AlchemyFn",
          query: search.query,
          tags: search.tags,
        })
      : undefined;
    return { group, workspace, fn };
  });

test.provider(
  "create, update, replace, and delete a saved search",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ query: "Usage | take 10", tags: { env: "test" } }),
      );
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      const first = created.fn!;
      const observed = yield* getSearch(rg, ws, first.savedSearchName);
      expect(observed.properties.query).toEqual("Usage | take 10");
      expect(observed.properties.functionAlias).toEqual("AlchemyFn");
      expect(
        observed.properties.tags?.find((t) => t.name === "alchemy::id")?.value,
      ).toEqual("Fn");
      expect(first.tags).toEqual({ env: "test" });

      // In-place update of the query and tags.
      const updated = yield* stack.deploy(
        program({ query: "Usage | take 20", tags: { env: "prod" } }),
      );
      expect(updated.fn!.savedSearchName).toEqual(first.savedSearchName);
      const reobserved = yield* getSearch(rg, ws, first.savedSearchName);
      expect(reobserved.properties.query).toEqual("Usage | take 20");
      expect(
        reobserved.properties.tags?.find((t) => t.name === "env")?.value,
      ).toEqual("prod");

      // Renaming replaces the search.
      const renamed = yield* stack.deploy(
        program({
          name: "alchemy-renamed-search",
          alias: "AlchemyFnRenamed",
          query: "Usage | take 20",
          tags: {},
        }),
      );
      expect(renamed.fn!.savedSearchName).toEqual("alchemy-renamed-search");
      yield* getSearch(rg, ws, "alchemy-renamed-search");
      expect(yield* searchGone(rg, ws, first.savedSearchName)).toEqual("gone");

      yield* stack.deploy(program());
      expect(yield* searchGone(rg, ws, "alchemy-renamed-search")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
