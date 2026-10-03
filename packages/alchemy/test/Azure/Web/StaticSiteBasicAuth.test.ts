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

const getBasicAuth = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetStaticSiteBasicAuth({
      subscriptionId,
      resourceGroupName,
      name,
      basicAuthName: "default",
    });
  });

/** "off" once no environment is protected (or the site is gone). */
const protectionOff = (resourceGroupName: string, name: string) =>
  getBasicAuth(resourceGroupName, name).pipe(
    Effect.map((observed) =>
      observed.properties?.applicableEnvironmentsMode ===
        "SpecifiedEnvironments" &&
      (observed.properties.environments ?? []).length === 0
        ? ("off" as const)
        : ("on" as const),
    ),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("off" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "off",
      times: 10,
    }),
  );

const password = "Alchemy-Test-Passw0rd!";

const program = (
  mode: "AllEnvironments" | "StagingEnvironments" | undefined,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus2",
    });
    const site = yield* Azure.Web.StaticSite("Site", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    const auth =
      mode === undefined
        ? undefined
        : yield* Azure.Web.StaticSiteBasicAuth("Password", {
            resourceGroup: group.resourceGroupName,
            staticSiteName: site.staticSiteName,
            password: Redacted.make(password),
            applicableEnvironmentsMode: mode,
          });
    return { group, site, auth };
  });

// Cost: Standard static site ~$9/month prorated (~$0.0125/h, under a cent
// per run). Provisioning: ~1-2 minutes.
test.provider(
  "enable, update, and disable static site password protection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site, auth } = yield* stack.deploy(
        program("StagingEnvironments"),
      );
      expect(auth!.applicableEnvironmentsMode).toEqual("StagingEnvironments");
      const observed = yield* getBasicAuth(
        group.resourceGroupName,
        site.staticSiteName,
      );
      expect(observed.properties?.applicableEnvironmentsMode).toEqual(
        "StagingEnvironments",
      );
      expect(observed.properties?.secretState).toEqual("Password");

      // In-place update: protect every environment.
      yield* stack.deploy(program("AllEnvironments"));
      const updated = yield* getBasicAuth(
        group.resourceGroupName,
        site.staticSiteName,
      );
      expect(updated.properties?.applicableEnvironmentsMode).toEqual(
        "AllEnvironments",
      );

      // Delete only the setting: protection turns off.
      yield* stack.deploy(program(undefined));
      expect(
        yield* protectionOff(group.resourceGroupName, site.staticSiteName),
      ).toEqual("off");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
