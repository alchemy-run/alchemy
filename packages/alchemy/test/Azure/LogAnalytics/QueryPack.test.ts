import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getPack = (resourceGroupName: string, queryPackName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetQueryPack({
      subscriptionId,
      resourceGroupName,
      queryPackName,
    });
  });

const packGone = (resourceGroupName: string, queryPackName: string) =>
  getPack(resourceGroupName, queryPackName).pipe(
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

const program = (props: { location?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const pack = yield* Azure.LogAnalytics.QueryPack("Pack", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
    });
    return { group, pack };
  });

test.provider(
  "create, update, replace, and delete a query pack",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const first = created.pack;
      expect(first.queryPackGuid).toMatch(/^[0-9a-f-]{36}$/);
      const observed = yield* getPack(rg, first.queryPackName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Pack");

      // In-place tag update.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.pack.queryPackGuid).toEqual(first.queryPackGuid);
      expect((yield* getPack(rg, first.queryPackName)).tags?.env).toEqual(
        "prod",
      );

      // Changing the location replaces the pack.
      const moved = yield* stack.deploy(
        program({ location: "westus2", tags: { env: "prod" } }),
      );
      expect(moved.pack.location.toLowerCase()).toEqual("westus2");
      expect(moved.pack.queryPackName).not.toEqual(first.queryPackName);
      expect(yield* packGone(rg, first.queryPackName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* packGone(rg, moved.pack.queryPackName)).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
