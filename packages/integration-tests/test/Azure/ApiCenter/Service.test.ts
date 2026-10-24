import * as Azure from "@alchemy.run/azure";
import * as apicenter from "@distilled.cloud/azure/apicenter";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  location: string;
  team: string;
  identity?: Azure.ApiCenter.ApiCenterServiceIdentity;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.ApiCenter.Service("Center", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      identity: props.identity,
      tags: { team: props.team },
    });
    return { group, center };
  });

// Free-plan API Center: $0, provisions in under a minute.
test.provider(
  "create, update, replace, and delete an API Center service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center } = yield* stack.deploy(
        program({ location: "eastus", team: "platform" }),
      );
      const subscriptionId = yield* subscription;
      const get = (serviceName: string) =>
        apicenter.GetService({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          serviceName,
        });
      expect(center.resourceGroup).toEqual(group.resourceGroupName);
      expect(center.tags).toEqual({ team: "platform" });
      expect(center.principalId).toBeUndefined();
      expect(center.dataApiHostname).toEqual(
        `${center.serviceName}.data.eastus.azure-apicenter.ms`,
      );
      const observed = yield* get(center.serviceName);
      expect(observed.id).toEqual(center.serviceId);
      expect(observed.location.toLowerCase().replaceAll(" ", "")).toEqual("eastus");
      expect(observed.tags?.team).toEqual("platform");
      expect(observed.tags?.["alchemy::id"]).toEqual("Center");

      // The service owns exactly one system-managed workspace, `default`.
      const workspaces = yield* apicenter.ListWorkspaces({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        serviceName: center.serviceName,
      });
      expect(workspaces.value.map((workspace) => workspace.name)).toEqual(["default"]);

      // In-place: tags and a system-assigned identity.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          team: "apis",
          identity: { type: "SystemAssigned" },
        }),
      );
      expect(updated.center.serviceId).toEqual(center.serviceId);
      expect(updated.center.tags).toEqual({ team: "apis" });
      expect(updated.center.principalId).toMatch(/^[0-9a-f-]{36}$/);
      const reobserved = yield* get(center.serviceName);
      expect(reobserved.tags?.team).toEqual("apis");
      expect(reobserved.identity?.type).toEqual("SystemAssigned");
      expect(reobserved.identity?.principalId).toEqual(updated.center.principalId);

      // Replacement: a new location creates a new service and deletes the old one.
      const replaced = yield* stack.deploy(
        program({
          location: "uksouth",
          team: "apis",
          identity: { type: "SystemAssigned" },
        }),
      );
      expect(replaced.center.serviceName).not.toEqual(center.serviceName);
      expect(replaced.center.location.toLowerCase().replaceAll(" ", "")).toEqual("uksouth");
      const moved = yield* get(replaced.center.serviceName);
      expect(moved.location.toLowerCase().replaceAll(" ", "")).toEqual("uksouth");
      expect(yield* waitGone(get(center.serviceName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.center.serviceName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
