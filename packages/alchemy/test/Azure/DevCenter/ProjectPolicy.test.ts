import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProjectPolicy = (
  resourceGroupName: string,
  devCenterName: string,
  projectPolicyName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetProjectPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      devCenterName,
      projectPolicyName,
    });
  });

const program = (props: { skus: "Allow" | "Deny"; scopedName?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.DevCenter.DevCenter("Center", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const project = yield* Azure.DevCenter.Project("Project", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      devCenterId: center.devCenterId,
    });
    // A dev center's first policy must be named `default`, and the default
    // policy applies to every project (no scopes).
    const policy = yield* Azure.DevCenter.ProjectPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      devCenter: center.devCenterName,
      name: "default",
      resourcePolicies: [{ resourceType: "Skus", action: props.skus }],
    });
    // Additional policies are scoped to projects and need `default` first.
    const scoped = yield* Azure.DevCenter.ProjectPolicy("Scoped", {
      resourceGroup: group.resourceGroupName,
      devCenter: policy.devCenter,
      name: props.scopedName,
      resourcePolicies: [{ resourceType: "Skus", action: "Allow" }],
      scopes: [project.projectId],
    });
    return { group, center, project, policy, scoped };
  });

// Dev centers, projects, and project policies are free; ~10 minutes in
// total (the dev center create and delete dominate), $0.
test.provider(
  "create, update, replace, and delete project policies",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, project, policy, scoped } = yield* stack.deploy(
        program({ skus: "Allow" }),
      );
      expect(policy.projectPolicyName).toEqual("default");
      const observed = yield* getProjectPolicy(
        group.resourceGroupName,
        center.devCenterName,
        "default",
      );
      expect(observed.id).toEqual(policy.projectPolicyId);
      expect(observed.properties?.scopes ?? []).toEqual([]);
      const observedScoped = yield* getProjectPolicy(
        group.resourceGroupName,
        center.devCenterName,
        scoped.projectPolicyName,
      );
      expect(
        observedScoped.properties?.scopes?.map((scope) => scope.toLowerCase()),
      ).toEqual([project.projectId.toLowerCase()]);
      expect(observed.properties?.resourcePolicies?.[0]?.action).toEqual(
        "Allow",
      );

      // In place: the resource policies.
      const updated = yield* stack.deploy(program({ skus: "Deny" }));
      expect(updated.policy.projectPolicyId).toEqual(policy.projectPolicyId);
      const reobserved = yield* getProjectPolicy(
        group.resourceGroupName,
        center.devCenterName,
        "default",
      );
      expect(reobserved.properties?.resourcePolicies?.[0]?.action).toEqual(
        "Deny",
      );

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({ skus: "Deny", scopedName: "scoped-renamed" }),
      );
      expect(replaced.scoped.projectPolicyName).toEqual("scoped-renamed");
      expect(replaced.policy.projectPolicyId).toEqual(policy.projectPolicyId);
      expect(
        yield* waitGone(
          getProjectPolicy(
            group.resourceGroupName,
            center.devCenterName,
            scoped.projectPolicyName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getProjectPolicy(
            group.resourceGroupName,
            center.devCenterName,
            "default",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
