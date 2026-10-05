import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dashboard from "@distilled.cloud/azure/dashboard";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getDashboard = (resourceGroupName: string, dashboardName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* dashboard.GetDashboard({
      subscriptionId,
      resourceGroupName,
      dashboardName,
    });
  });

const dashboardGone = (resourceGroupName: string, dashboardName: string) =>
  getDashboard(resourceGroupName, dashboardName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: { location: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const board = yield* Azure.Dashboard.ManagedDashboard("Board", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
    });
    return { group, board };
  });

// Free: a managed dashboard has no charge.
test.provider(
  "create, update, replace, and delete a managed dashboard",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, board } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      expect(board.dashboardName).toMatch(/^[a-z][a-z0-9-]{1,22}$/);
      expect(board.location).toEqual("eastus");
      expect(board.tags).toEqual({ env: "test" });
      const observed = yield* getDashboard(
        group.resourceGroupName,
        board.dashboardName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Board");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "prod", team: "ops" } }),
      );
      expect(updated.board.dashboardName).toEqual(board.dashboardName);
      const reobserved = yield* getDashboard(
        group.resourceGroupName,
        board.dashboardName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.team).toEqual("ops");

      // Replacement: location.
      const replaced = yield* stack.deploy(
        program({ location: "westus2", tags: { env: "prod", team: "ops" } }),
      );
      expect(replaced.board.dashboardName).not.toEqual(board.dashboardName);
      expect(replaced.board.location).toEqual("westus2");
      expect(
        yield* dashboardGone(group.resourceGroupName, board.dashboardName),
      ).toEqual("gone");
      const moved = yield* getDashboard(
        group.resourceGroupName,
        replaced.board.dashboardName,
      );
      expect(moved.location).toEqual("westus2");

      yield* stack.destroy();
      expect(
        yield* dashboardGone(
          group.resourceGroupName,
          replaced.board.dashboardName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:dashboard", "live"],
    timeout: 600_000,
  },
);
