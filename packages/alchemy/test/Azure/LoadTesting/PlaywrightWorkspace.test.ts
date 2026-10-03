import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as loadtestservice from "@distilled.cloud/azure/loadtestservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getWorkspace = (
  resourceGroupName: string,
  playwrightWorkspaceName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* loadtestservice.GetPlaywrightWorkspace({
      subscriptionId,
      resourceGroupName,
      playwrightWorkspaceName,
    });
  });

const workspaceGone = (resourceGroupName: string, workspaceName: string) =>
  getWorkspace(resourceGroupName, workspaceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  localAuth: "Enabled" | "Disabled";
  regionalAffinity: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LoadTesting.PlaywrightWorkspace(
      "Browsers",
      {
        resourceGroup: group.resourceGroupName,
        localAuth: props.localAuth,
        regionalAffinity: props.regionalAffinity,
        tags: props.tags,
      },
    );
    return { group, workspace };
  });

// Idle workspaces are free (billing is per test minute); create/delete
// takes ~1-2 minutes.
test.provider(
  "create, update, and delete a Playwright workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          localAuth: "Disabled",
          regionalAffinity: "Enabled",
          tags: { env: "test" },
        }),
      );
      const { group, workspace } = created;
      expect(workspace.workspaceName).toMatch(/^[a-z0-9-]{3,24}$/);
      expect(workspace.provisioningState).toEqual("Succeeded");
      expect(workspace.workspaceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(workspace.dataplaneUri).toBeDefined();
      const observed = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(observed.properties?.localAuth).toEqual("Disabled");
      expect(observed.properties?.regionalAffinity).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Browsers");

      const updated = yield* stack.deploy(
        program({
          localAuth: "Enabled",
          regionalAffinity: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.workspace.playwrightWorkspaceId).toEqual(
        workspace.playwrightWorkspaceId,
      );
      const reobserved = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(reobserved.properties?.localAuth).toEqual("Enabled");
      expect(reobserved.properties?.regionalAffinity).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* workspaceGone(group.resourceGroupName, workspace.workspaceName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:loadtesting", "live"],
    timeout: 900_000,
  },
);
