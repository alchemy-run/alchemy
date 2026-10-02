import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getScalingPlan = (resourceGroupName: string, scalingPlanName: string) =>
  Effect.gen(function* () {
    return yield* desktopvirtualization.GetScalingPlan({
      subscriptionId: yield* subscription,
      resourceGroupName,
      scalingPlanName,
    });
  });

const program = (props: {
  hostPoolType: "Pooled" | "Personal";
  assign: boolean;
  timeZone: string;
  exclusionTag: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const pool = yield* Azure.DesktopVirtualization.HostPool("Pool", {
      resourceGroup: group.resourceGroupName,
      location,
      hostPoolType: "Pooled",
      loadBalancerType: "BreadthFirst",
    });
    const plan = yield* Azure.DesktopVirtualization.ScalingPlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location,
      hostPoolType: props.hostPoolType,
      timeZone: props.timeZone,
      exclusionTag: props.exclusionTag,
      tags: props.tags,
      // Disabled: enabling needs a role for the AVD service principal.
      hostPoolReferences: props.assign
        ? [{ hostPoolId: pool.hostPoolId, scalingPlanEnabled: false }]
        : [],
    });
    return { group, pool, plan };
  });

/** A plan read right after its creation can briefly 404 (read replica lag). */
const getCreatedScalingPlan = (
  resourceGroupName: string,
  scalingPlanName: string,
) =>
  getScalingPlan(resourceGroupName, scalingPlanName).pipe(
    Effect.retry({
      while: (e) => e._tag === "NotFound",
      schedule: Schedule.spaced("2 seconds"),
      times: 10,
    }),
  );

// Scaling plans are free metadata objects.
test.provider(
  "create, update, replace, and delete a scaling plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, plan } = yield* stack.deploy(
        program({
          hostPoolType: "Pooled",
          assign: false,
          timeZone: "UTC",
          exclusionTag: "skip",
          tags: { env: "test" },
        }),
      );
      const rg = group.resourceGroupName;
      const observed = yield* getCreatedScalingPlan(rg, plan.scalingPlanName);
      expect(observed.properties.timeZone).toEqual("UTC");
      expect(observed.properties.exclusionTag).toEqual("skip");
      expect(observed.properties.hostPoolReferences ?? []).toEqual([]);
      expect(observed.tags?.env).toEqual("test");

      // In place: time zone, exclusion tag, and tags.
      const updated = yield* stack.deploy(
        program({
          hostPoolType: "Pooled",
          assign: false,
          timeZone: "Pacific Standard Time",
          exclusionTag: "noscale",
          tags: { env: "prod" },
        }),
      );
      expect(updated.plan.scalingPlanId).toEqual(plan.scalingPlanId);
      const reobserved = yield* getScalingPlan(rg, plan.scalingPlanName);
      expect(reobserved.properties.timeZone).toEqual("Pacific Standard Time");
      expect(reobserved.properties.exclusionTag).toEqual("noscale");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the host pool type is immutable.
      const replaced = yield* stack.deploy(
        program({
          hostPoolType: "Personal",
          assign: false,
          timeZone: "UTC",
          exclusionTag: "noscale",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.plan.scalingPlanName).not.toEqual(plan.scalingPlanName);
      const personal = yield* getCreatedScalingPlan(
        rg,
        replaced.plan.scalingPlanName,
      );
      expect(personal.properties.hostPoolType).toEqual("Personal");
      expect(yield* waitGone(getScalingPlan(rg, plan.scalingPlanName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getScalingPlan(rg, replaced.plan.scalingPlanName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: assigning a host pool (even with scaling disabled) needs
// the "Desktop Virtualization Power On Off Contributor" role for the Azure
// Virtual Desktop service principal (appId 9cdead84-a844-4324-93f2-
// b2e6bb768d07). The test subscription does not grant it, and ARM rejects
// the plan with `AvdServicePrincipalAccessDenied`.
test.provider(
  "assigning a host pool without the AVD service principal role is rejected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, pool } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location,
          });
          const pool = yield* Azure.DesktopVirtualization.HostPool("Pool", {
            resourceGroup: group.resourceGroupName,
            location,
            hostPoolType: "Pooled",
            loadBalancerType: "BreadthFirst",
          });
          return { group, pool };
        }),
      );
      const error = yield* desktopvirtualization
        .CreateScalingPlan({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          scalingPlanName: "alchemy-avd-probe",
          location,
          properties: {
            timeZone: "UTC",
            hostPoolType: "Pooled",
            hostPoolReferences: [
              { hostPoolArmPath: pool.hostPoolId, scalingPlanEnabled: false },
            ],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("AvdServicePrincipalAccessDenied");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getScalingPlan(group.resourceGroupName, "alchemy-avd-probe"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Needs the "Desktop Virtualization Power On Off Contributor" role assigned
// to the Azure Virtual Desktop service principal on the subscription (see
// the probe above). Free metadata objects otherwise.
test.provider.skipIf(!process.env.AZURE_TEST_AVD_ROLE)(
  "assign and unassign a host pool on a scaling plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = {
        hostPoolType: "Pooled" as const,
        timeZone: "UTC",
        exclusionTag: "skip",
        tags: { env: "test" },
      };
      const { group, pool, plan } = yield* stack.deploy(
        program({ ...base, assign: true }),
      );
      const rg = group.resourceGroupName;
      const observed = yield* getCreatedScalingPlan(rg, plan.scalingPlanName);
      expect(
        observed.properties.hostPoolReferences?.map((ref) => [
          ref.hostPoolArmPath?.toLowerCase(),
          ref.scalingPlanEnabled,
        ]),
      ).toEqual([[pool.hostPoolId.toLowerCase(), false]]);

      yield* stack.deploy(program({ ...base, assign: false }));
      const unassigned = yield* getScalingPlan(rg, plan.scalingPlanName);
      expect(unassigned.properties.hostPoolReferences ?? []).toEqual([]);

      yield* stack.destroy();
      expect(yield* waitGone(getScalingPlan(rg, plan.scalingPlanName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
