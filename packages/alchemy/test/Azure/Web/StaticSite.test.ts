import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const where = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return { subscriptionId, resourceGroupName, name };
  });

const getSite = (resourceGroupName: string, name: string) =>
  where(resourceGroupName, name).pipe(
    Effect.flatMap((request) => web.GetStaticSiteStaticSite(request)),
  );

const siteGone = (resourceGroupName: string, name: string) =>
  getSite(resourceGroupName, name).pipe(
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
  location: string;
  stagingEnvironmentPolicy: "Enabled" | "Disabled";
  appSettings: Record<string, string>;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus2",
    });
    const site = yield* Azure.Web.StaticSite("Site", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      stagingEnvironmentPolicy: props.stagingEnvironmentPolicy,
      appSettings: props.appSettings,
      tags: props.tags,
    });
    return { group, site };
  });

// Cost: $0 (Free SKU). Provisioning: under a minute per site.
test.provider(
  "create, update, replace, and delete a static site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site } = yield* stack.deploy(
        program({
          location: "eastus2",
          stagingEnvironmentPolicy: "Enabled",
          appSettings: { GREETING: "hello" },
          tags: { env: "test" },
        }),
      );
      expect(site.sku).toEqual("Free");
      expect(site.defaultHostname).toContain(".azurestaticapps.net");
      expect(site.url).toEqual(`https://${site.defaultHostname}`);
      expect(Redacted.value(site.deploymentToken!).length).toBeGreaterThan(20);

      const observed = yield* getSite(
        group.resourceGroupName,
        site.staticSiteName,
      );
      expect(observed.sku?.name).toEqual("Free");
      expect(observed.properties?.stagingEnvironmentPolicy).toEqual("Enabled");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Site");
      const settings = yield* where(
        group.resourceGroupName,
        site.staticSiteName,
      ).pipe(
        Effect.flatMap((request) =>
          web.ListStaticSiteStaticSiteAppSettings(request),
        ),
      );
      expect(settings.properties).toEqual({ GREETING: "hello" });

      // In-place update: staging policy, app settings, and tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus2",
          stagingEnvironmentPolicy: "Disabled",
          appSettings: { GREETING: "bonjour", MODE: "prod" },
          tags: { env: "prod" },
        }),
      );
      expect(updated.site.staticSiteName).toEqual(site.staticSiteName);
      const reobserved = yield* getSite(
        group.resourceGroupName,
        site.staticSiteName,
      );
      expect(reobserved.properties?.stagingEnvironmentPolicy).toEqual(
        "Disabled",
      );
      expect(reobserved.tags?.env).toEqual("prod");
      const resettings = yield* where(
        group.resourceGroupName,
        site.staticSiteName,
      ).pipe(
        Effect.flatMap((request) =>
          web.ListStaticSiteStaticSiteAppSettings(request),
        ),
      );
      expect(resettings.properties).toEqual({
        GREETING: "bonjour",
        MODE: "prod",
      });

      // Replacement: the location cannot change in place.
      const replaced = yield* stack.deploy(
        program({
          location: "centralus",
          stagingEnvironmentPolicy: "Disabled",
          appSettings: { GREETING: "bonjour", MODE: "prod" },
          tags: { env: "prod" },
        }),
      );
      expect(replaced.site.staticSiteName).not.toEqual(site.staticSiteName);
      const moved = yield* getSite(
        group.resourceGroupName,
        replaced.site.staticSiteName,
      );
      expect(moved.location.toLowerCase().replaceAll(" ", "")).toEqual(
        "centralus",
      );
      expect(
        yield* siteGone(group.resourceGroupName, site.staticSiteName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* siteGone(group.resourceGroupName, replaced.site.staticSiteName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
