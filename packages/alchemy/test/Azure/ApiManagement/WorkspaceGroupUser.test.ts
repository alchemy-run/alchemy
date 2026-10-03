import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { basicV2Workspace, logLevel, subscriptionId, tags } from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const members = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListWorkspaceGroupUser({
      subscriptionId,
      resourceGroupName,
      serviceName,
      workspaceId: "alchemy-ws",
      groupId: "alchemy-partners",
    }),
  ).pipe(Effect.map((page) => (page.value ?? []).map((u) => u.name ?? "")));

/** Poll until the group's members match `expected` (bounded). */
const untilMembers = (
  resourceGroupName: string,
  serviceName: string,
  expected: string[],
) =>
  members(resourceGroupName, serviceName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (names) => names.sort().join(",") === expected.sort().join(","),
      times: 10,
    }),
  );

const program = (member?: "jane" | "joe") =>
  Effect.gen(function* () {
    const { group, service, workspace } = yield* basicV2Workspace;
    const partners = yield* Azure.ApiManagement.WorkspaceGroup("Partners", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      workspaceName: workspace.workspaceName,
      name: "alchemy-partners",
      displayName: "Partners",
    });
    // Both users stay deployed across the replacement step.
    const jane = yield* Azure.ApiManagement.User("Jane", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-jane",
      email: "alchemy-jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
    });
    const joe = yield* Azure.ApiManagement.User("Joe", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-joe",
      email: "alchemy-joe@example.com",
      firstName: "Joe",
      lastName: "Doe",
    });
    const membership = member
      ? yield* Azure.ApiManagement.WorkspaceGroupUser("Member", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          workspaceName: workspace.workspaceName,
          groupName: partners.groupName,
          userName: member === "jane" ? jane.userName : joe.userName,
        })
      : undefined;
    return { group, service, membership };
  });

// Workspaces need BasicV2/StandardV2/Premium ("Method not allowed in
// Consumption pricing tier"). A BasicV2 service bills ~$0.21/h and
// takes 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "add, replace, and remove a workspace group member",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program("jane"));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.membership?.userName).toEqual("alchemy-jane");
      expect(yield* untilMembers(rg, svc, ["alchemy-jane"])).toEqual([
        "alchemy-jane",
      ]);

      // Replacement: another user joins, the old membership is removed.
      yield* stack.deploy(program("joe"));
      expect(yield* untilMembers(rg, svc, ["alchemy-joe"])).toEqual([
        "alchemy-joe",
      ]);

      // Removing the resource removes the membership.
      yield* stack.deploy(program());
      expect(yield* untilMembers(rg, svc, [])).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
