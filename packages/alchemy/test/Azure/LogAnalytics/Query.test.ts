import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getQuery = (resourceGroupName: string, queryPackName: string, id: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetQuery({
      subscriptionId,
      resourceGroupName,
      queryPackName,
      id,
    });
  });

const queryGone = (resourceGroupName: string, queryPackName: string, id: string) =>
  getQuery(resourceGroupName, queryPackName, id).pipe(
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

const REPLACEMENT_ID = "5b0f7a3e-4c1d-4e2a-9f6b-0a1c2d3e4f50";

const program = (query?: { queryId?: string; body: string; category: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const pack = yield* Azure.LogAnalytics.QueryPack("Pack", {
      resourceGroup: group.resourceGroupName,
    });
    const saved = query
      ? yield* Azure.LogAnalytics.Query("Query", {
          resourceGroup: group.resourceGroupName,
          queryPack: pack.queryPackName,
          queryId: query.queryId,
          // Display names are unique per pack; a create-first replacement needs a new one.
          displayName: query.queryId ? "Alchemy replacement" : "Alchemy query",
          body: query.body,
          related: { categories: [query.category] },
          tags: { team: ["platform"] },
        })
      : undefined;
    return { group, pack, saved };
  });

test.provider(
  "create, update, replace, and delete a query pack query",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ body: "Usage | take 10", category: "applications" }),
      );
      const rg = created.group.resourceGroupName;
      const pack = created.pack.queryPackName;
      const first = created.saved!;
      expect(first.queryId).toMatch(/^[0-9a-f-]{36}$/);
      const observed = yield* getQuery(rg, pack, first.queryId);
      expect(observed.properties?.body).toEqual("Usage | take 10");
      expect(observed.properties?.related?.categories).toEqual(["applications"]);
      expect(observed.properties?.tags?.team).toEqual(["platform"]);
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual(["Query"]);

      // In-place update of the body and categories.
      const updated = yield* stack.deploy(
        program({ body: "Usage | take 20", category: "monitor" }),
      );
      expect(updated.saved!.queryId).toEqual(first.queryId);
      const reobserved = yield* getQuery(rg, pack, first.queryId);
      expect(reobserved.properties?.body).toEqual("Usage | take 20");
      expect(reobserved.properties?.related?.categories).toEqual(["monitor"]);

      // Changing the query ID replaces the query.
      const replaced = yield* stack.deploy(
        program({
          queryId: REPLACEMENT_ID,
          body: "Usage | take 20",
          category: "monitor",
        }),
      );
      expect(replaced.saved!.queryId).toEqual(REPLACEMENT_ID);
      yield* getQuery(rg, pack, REPLACEMENT_ID);
      expect(yield* queryGone(rg, pack, first.queryId)).toEqual("gone");

      yield* stack.deploy(program());
      expect(yield* queryGone(rg, pack, REPLACEMENT_ID)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
