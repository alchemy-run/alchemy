import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// A purchasable Marketplace offer for App Service add-ons. Set these with
// AZURE_TEST_PAID=1 to run the lifecycle.
const OFFER = {
  publisher: process.env.AZURE_TEST_PREMIER_ADDON_PUBLISHER ?? "",
  offer: process.env.AZURE_TEST_PREMIER_ADDON_OFFER ?? "",
  plan: process.env.AZURE_TEST_PREMIER_ADDON_PLAN ?? "",
};

const getAddOn = (resourceGroupName: string, name: string, premierAddOnName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.WebAppsGetPremierAddOn({
      subscriptionId,
      resourceGroupName,
      name,
      premierAddOnName,
    });
  });

const addOnGone = (resourceGroupName: string, name: string, premierAddOnName: string) =>
  getAddOn(resourceGroupName, name, premierAddOnName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (addOn: { name?: string; tags: Record<string, string> } | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // eastus has zero App Service quota; westus2 has F1/B1 quota.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "F1",
      os: "linux",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "linux",
      siteConfig: { alwaysOn: false },
    });
    const premier =
      addOn === undefined
        ? undefined
        : yield* Azure.Web.PremierAddOn("AddOn", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            location: "westus2",
            name: addOn.name,
            publisher: OFFER.publisher,
            offer: OFFER.offer,
            plan: OFFER.plan,
            tags: addOn.tags,
          });
    return { group, app, premier };
  });

// A premier add-on is a Marketplace purchase from a partner: it needs a
// purchasable offer (AZURE_TEST_PREMIER_ADDON_PUBLISHER / _OFFER / _PLAN),
// so it runs only with AZURE_TEST_PAID=1. Cost: the offer's plan price
// (pick a free plan) on an F1 Free app ($0). Provisioning: ~1-2 minutes.
test.provider.skipIf(!runPaidOnly)(
  "purchase, retag, replace, and delete a premier add-on",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "one" } }));
      const { group, app } = created;
      const premier = created.premier!;
      expect(premier.offer).toEqual(OFFER.offer);
      expect(premier.tags).toEqual({ env: "one" });
      const observed = yield* getAddOn(group.resourceGroupName, app.siteName, premier.addOnName);
      expect(observed.properties?.marketplaceOffer).toEqual(OFFER.offer);

      // In-place update: tags.
      const retagged = yield* stack.deploy(program({ tags: { env: "two" } }));
      expect(retagged.premier!.addOnId).toEqual(premier.addOnId);
      const reobserved = yield* getAddOn(group.resourceGroupName, app.siteName, premier.addOnName);
      expect(reobserved.tags?.env).toEqual("two");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-renamed", tags: { env: "two" } }),
      );
      expect(replaced.premier!.addOnName).toEqual("alchemy-renamed");
      expect(yield* addOnGone(group.resourceGroupName, app.siteName, premier.addOnName)).toEqual(
        "gone",
      );

      // Delete only the add-on.
      yield* stack.deploy(program(undefined));
      expect(yield* addOnGone(group.resourceGroupName, app.siteName, "alchemy-renamed")).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

// Probe: an add-on for an offer that is not in the Marketplace fails the
// purchase validation with a typed error. Cost: $0 (F1 Free plan).
// Provisioning: ~1 minute.
test.provider(
  "a premier add-on for an unknown offer fails with MarketplacePurchaseValidationFailed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, app } = yield* stack.deploy(program(undefined));
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* web
        .WebAppsAddPremierAddOn({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: app.siteName,
          premierAddOnName: "alchemy-probe",
          location: "westus2",
          plan: { name: "free", publisher: "alchemy", product: "alchemy-probe" },
          properties: {
            sku: "free",
            product: "alchemy-probe",
            vendor: "alchemy",
            marketplacePublisher: "alchemy",
            marketplaceOffer: "alchemy-probe",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MarketplacePurchaseValidationFailed");
      expect(yield* addOnGone(group.resourceGroupName, app.siteName, "alchemy-probe")).toEqual(
        "gone",
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
