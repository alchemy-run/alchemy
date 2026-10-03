import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dashboard from "@distilled.cloud/azure/dashboard";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getEndpoint = (
  resourceGroupName: string,
  workspaceName: string,
  managedPrivateEndpointName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* dashboard.GetManagedPrivateEndpoint({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      managedPrivateEndpointName,
    });
  });

const endpointGone = (
  resourceGroupName: string,
  workspaceName: string,
  managedPrivateEndpointName: string,
) =>
  getEndpoint(resourceGroupName, workspaceName, managedPrivateEndpointName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const workspaceGone = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* dashboard
      .GetGrafana({ subscriptionId, resourceGroupName, workspaceName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(
          ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
          () => Effect.succeed("gone" as const),
        ),
      );
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const program = (props: {
  endpoint: boolean;
  requestMessage: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.Grafana.Workspace("Grafana", {
      resourceGroup: group.resourceGroupName,
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const endpoint = props.endpoint
      ? yield* Azure.Grafana.ManagedPrivateEndpoint("Blob", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          privateLinkResourceId: account.storageAccountId,
          groupIds: ["blob"],
          requestMessage: props.requestMessage,
          tags: props.tags,
        })
      : undefined;
    return { group, workspace, account, endpoint };
  });

// A Standard Grafana workspace (~$0.07/hour) plus a storage account: cents
// per run, but Grafana takes ~3 min to create and ~8 min to delete, so the
// whole lifecycle runs ~15 min — over the time budget.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Grafana managed private endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          endpoint: true,
          requestMessage: "alchemy test",
          tags: { env: "test" },
        }),
      );
      const { group, workspace, account } = created;
      const endpoint = created.endpoint!;
      expect(endpoint.groupIds).toEqual(["blob"]);
      expect(endpoint.privateLinkResourceId?.toLowerCase()).toEqual(
        account.storageAccountId.toLowerCase(),
      );
      expect(["Pending", "Approved"]).toContain(endpoint.connectionStatus);
      const observed = yield* getEndpoint(
        group.resourceGroupName,
        workspace.workspaceName,
        endpoint.managedPrivateEndpointName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.requestMessage).toEqual("alchemy test");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Blob");

      // In-place updates: request message (re-PUT) and tags (PATCH).
      const updated = yield* stack.deploy(
        program({
          endpoint: true,
          requestMessage: "alchemy test updated",
          tags: { env: "prod" },
        }),
      );
      expect(updated.endpoint!.managedPrivateEndpointName).toEqual(
        endpoint.managedPrivateEndpointName,
      );
      const reobserved = yield* getEndpoint(
        group.resourceGroupName,
        workspace.workspaceName,
        endpoint.managedPrivateEndpointName,
      );
      expect(reobserved.properties?.requestMessage).toEqual(
        "alchemy test updated",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Delete the endpoint alone, keeping the workspace.
      yield* stack.deploy(
        program({ endpoint: false, requestMessage: "", tags: {} }),
      );
      expect(
        yield* endpointGone(
          group.resourceGroupName,
          workspace.workspaceName,
          endpoint.managedPrivateEndpointName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* workspaceGone(group.resourceGroupName, workspace.workspaceName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:grafana", "live"],
    timeout: 900_000,
  },
);
