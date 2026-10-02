import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  basicV2Service,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (
  resourceGroupName: string,
  serviceName: string,
  workspaceId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      serviceName,
      workspaceId,
    }),
  );

const program = (workspace?: { name: string; displayName: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const created = workspace
      ? yield* Azure.ApiManagement.Workspace("Team", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: workspace.name,
          displayName: workspace.displayName,
          description: "Alchemy test workspace",
        })
      : undefined;
    return { group, service, workspace: created };
  });

// Workspaces need BasicV2/StandardV2/Premium ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and takes
// 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-ws", displayName: "Team" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.workspace?.workspaceName).toEqual("alchemy-ws");
      expect(
        (yield* getWorkspace(rg, svc, "alchemy-ws")).properties?.displayName,
      ).toEqual("Team");

      // In-place update of the display name.
      yield* stack.deploy(
        program({ name: "alchemy-ws", displayName: "Team renamed" }),
      );
      expect(
        (yield* getWorkspace(rg, svc, "alchemy-ws")).properties?.displayName,
      ).toEqual("Team renamed");

      // Replacement: a new identifier creates a new workspace.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-ws-v2", displayName: "Team v2" }),
      );
      expect(replaced.workspace?.workspaceName).toEqual("alchemy-ws-v2");
      expect(yield* untilGone(getWorkspace(rg, svc, "alchemy-ws"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the workspace.
      yield* stack.deploy(program());
      expect(yield* untilGone(getWorkspace(rg, svc, "alchemy-ws-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
