import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/** The observed `{ ftp, scm }` policies of an app or slot. */
const observePolicies = (resourceGroupName: string, name: string, slot?: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = { subscriptionId, resourceGroupName, name };
    const ftp =
      slot === undefined
        ? yield* web.GetWebAppFtpAllowed(where)
        : yield* web.GetWebAppFtpAllowedSlot({ ...where, slot });
    const scm =
      slot === undefined
        ? yield* web.GetWebAppScmAllowed(where)
        : yield* web.GetWebAppScmAllowedSlot({ ...where, slot });
    return { ftp: ftp.properties?.allow, scm: scm.properties?.allow };
  });

const program = (policy: { slot?: string; ftp?: boolean; scm?: boolean } | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // eastus has zero App Service quota; westus2 accepts S1 plans (its F1
    // capacity is often exhausted: "No available instances to satisfy this
    // request"). Slots need S1 anyway.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "S1",
      os: "linux",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "linux",
      siteConfig: { alwaysOn: false },
    });
    const slot = yield* Azure.Web.WebAppSlot("Slot", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      name: "staging",
      siteConfig: { alwaysOn: false },
    });
    const credentials =
      policy === undefined
        ? undefined
        : yield* Azure.Web.PublishingCredentialsPolicy("NoBasicAuth", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            slot: policy.slot === undefined ? undefined : slot.slotName,
            ftp: policy.ftp,
            scm: policy.scm,
          });
    return { group, app, credentials };
  });

// S1 plan: ~$0.10/h, about $0.02 per run. Provisioning: ~2-3 minutes.
test.provider(
  "allow, update, and release basic publishing credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // A new app starts with basic authentication disallowed.
      const { group, app } = yield* stack.deploy(program(undefined));
      expect(yield* observePolicies(group.resourceGroupName, app.siteName)).toEqual({
        ftp: false,
        scm: false,
      });

      const { credentials } = yield* stack.deploy(program({ scm: true }));
      expect(credentials?.ftp).toEqual(false);
      expect(credentials?.scm).toEqual(true);
      expect(yield* observePolicies(group.resourceGroupName, app.siteName)).toEqual({
        ftp: false,
        scm: true,
      });

      // In-place update: allow FTP too.
      const updated = yield* stack.deploy(program({ ftp: true, scm: true }));
      expect(updated.credentials?.ftp).toEqual(true);
      expect(yield* observePolicies(group.resourceGroupName, app.siteName)).toEqual({
        ftp: true,
        scm: true,
      });

      // Removing the resource leaves the policies as they are.
      yield* stack.deploy(program(undefined));
      expect(yield* observePolicies(group.resourceGroupName, app.siteName)).toEqual({
        ftp: true,
        scm: true,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

// S1 plan: ~$0.10/h, about $0.02 per run. Provisioning: ~2-3 minutes.
test.provider(
  "manage basic publishing credentials of a deployment slot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app } = yield* stack.deploy(
        program({ slot: "staging", ftp: true, scm: true }),
      );
      expect(yield* observePolicies(group.resourceGroupName, app.siteName, "staging")).toEqual({
        ftp: true,
        scm: true,
      });
      // The production slot keeps its own (default) policies.
      expect(yield* observePolicies(group.resourceGroupName, app.siteName)).toEqual({
        ftp: false,
        scm: false,
      });

      // In-place update: disallow both on the slot.
      yield* stack.deploy(program({ slot: "staging", ftp: false, scm: false }));
      expect(yield* observePolicies(group.resourceGroupName, app.siteName, "staging")).toEqual({
        ftp: false,
        scm: false,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
