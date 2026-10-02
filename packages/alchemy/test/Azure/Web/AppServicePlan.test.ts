import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getPlan = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetAppServicePlan({
      subscriptionId,
      resourceGroupName,
      name,
    });
  });

const planGone = (resourceGroupName: string, name: string) =>
  getPlan(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  os: Azure.Web.AppServicePlanOs;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      // The free trial has F1 quota in centralus but not in eastus.
      location: "centralus",
      sku: "F1",
      os: props.os,
      tags: props.tags,
    });
    return { group, plan };
  });

// Cost: $0 (F1 Free tier). Provisioning: ~1 minute per plan.
test.provider(
  "create, update, replace, and delete an app service plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, plan } = yield* stack.deploy(
        program({ os: "linux", tags: { env: "test" } }),
      );
      expect(plan.sku).toEqual("F1");
      expect(plan.os).toEqual("linux");
      expect(plan.appServicePlanId).toContain(
        "/providers/Microsoft.Web/serverfarms/",
      );
      const observed = yield* getPlan(
        group.resourceGroupName,
        plan.appServicePlanName,
      );
      expect(observed.sku?.name).toEqual("F1");
      expect(observed.properties?.reserved).toEqual(true);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Plan");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        program({ os: "linux", tags: { env: "prod" } }),
      );
      expect(updated.plan.appServicePlanName).toEqual(plan.appServicePlanName);
      const retagged = yield* getPlan(
        group.resourceGroupName,
        plan.appServicePlanName,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (p) => p.tags?.env === "prod",
          times: 10,
        }),
      );
      expect(retagged.tags?.env).toEqual("prod");

      // Replacement: Linux -> Windows cannot be converted in place.
      const replaced = yield* stack.deploy(
        program({ os: "windows", tags: { env: "prod" } }),
      );
      expect(replaced.plan.appServicePlanName).not.toEqual(
        plan.appServicePlanName,
      );
      expect(replaced.plan.os).toEqual("windows");
      const windows = yield* getPlan(
        group.resourceGroupName,
        replaced.plan.appServicePlanName,
      );
      expect(windows.properties?.reserved ?? false).toEqual(false);
      expect(
        yield* planGone(group.resourceGroupName, plan.appServicePlanName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* planGone(
          group.resourceGroupName,
          replaced.plan.appServicePlanName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

// Basic (B1) plans have zero VM quota on the free trial. Cost on a paid
// subscription: ~$0.018/h, under $0.01 per run.
test.provider.skipIf(!runPaidOnly)(
  "scale an app service plan from F1 to B1 in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (sku: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {
              location: "eastus",
            });
            const plan = yield* Azure.Web.AppServicePlan("Plan", {
              resourceGroup: group.resourceGroupName,
              sku,
            });
            return { group, plan };
          }),
        );
      const { group, plan } = yield* deploy("F1");
      const scaled = yield* deploy("B1");
      expect(scaled.plan.appServicePlanName).toEqual(plan.appServicePlanName);
      const observed = yield* getPlan(
        group.resourceGroupName,
        plan.appServicePlanName,
      );
      expect(observed.sku?.name).toEqual("B1");
      expect(observed.sku?.tier).toEqual("Basic");
      yield* stack.destroy();
      expect(
        yield* planGone(group.resourceGroupName, plan.appServicePlanName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

// Probe: the free trial rejects Basic plans for lack of quota, typed as
// QuotaExceeded (Microsoft.Web reports it as `Unauthorized`).
test.provider.skipIf(runPaidOnly)(
  "free trial rejects a B1 plan with QuotaExceeded",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* web
        .AppServicePlansCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: "quota-probe-b1",
          location: "eastus",
          kind: "linux",
          sku: { name: "B1", tier: "Basic" },
          properties: { reserved: true },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("QuotaExceeded");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 300_000,
  },
);
