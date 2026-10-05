import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  flexApp,
  flexConnectionString,
  flexStorage,
} from "./fixtures/flex-app.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * A domain whose DNS the tester controls, e.g. `alchemy-test.example.com`.
 * Before the run, point `www.{domain}` (CNAME) at the app's default host
 * name and set the `asuid.www.{domain}` TXT record to the subscription's
 * custom domain verification ID.
 */
const testDomain = process.env.AZURE_TEST_WEB_DOMAIN;

const getBinding = (
  resourceGroupName: string,
  name: string,
  hostName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppHostNameBinding({
      subscriptionId,
      resourceGroupName,
      name,
      hostName,
    });
  });

const bindingGone = (
  resourceGroupName: string,
  name: string,
  hostName: string,
) =>
  getBinding(resourceGroupName, name, hostName).pipe(
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

const site = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  // The free trial has F1 quota in centralus but not in eastus. Shared/F1
  // apps bind custom hostnames on Windows (without TLS).
  const plan = yield* Azure.Web.AppServicePlan("Plan", {
    resourceGroup: group.resourceGroupName,
    location: "centralus",
    sku: "F1",
    os: "windows",
  });
  const app = yield* Azure.Web.WebApp("Site", {
    resourceGroup: group.resourceGroupName,
    serverFarmId: plan.appServicePlanId,
    os: "windows",
    siteConfig: { alwaysOn: false },
  });
  return { group, app };
});

const program = (hostName: string) =>
  Effect.gen(function* () {
    const { group, app } = yield* site;
    const binding = yield* Azure.Web.HostNameBinding("Binding", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      hostName,
    });
    return { group, app, binding };
  });

// Binding needs DNS records for a domain the tester controls; set
// AZURE_TEST_WEB_DOMAIN (see above). Cost: $0 (F1 Free plan).
test.provider.skipIf(!testDomain)(
  "bind, replace, and unbind a custom hostname",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = `www.${testDomain}`;
      const second = `app.${testDomain}`;

      const { group, app, binding } = yield* stack.deploy(program(first));
      expect(binding.hostName).toEqual(first);
      const observed = yield* getBinding(
        group.resourceGroupName,
        app.siteName,
        first,
      );
      expect(observed.properties?.sslState ?? "Disabled").toEqual("Disabled");

      // Replacement: the hostname cannot change in place.
      const replaced = yield* stack.deploy(program(second));
      expect(replaced.binding.hostName).toEqual(second);
      expect(
        yield* bindingGone(group.resourceGroupName, app.siteName, first),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* bindingGone(group.resourceGroupName, app.siteName, second),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);

// Probe: without the DNS records Azure rejects the binding, typed as
// HostNameVerificationFailed. Runs on a Flex Consumption app (~$0).
test.provider(
  "binding an unverified hostname fails with HostNameVerificationFailed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );
      const { app } = yield* stack.deploy(flexApp(connection));
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* web
        .WebAppsCreateOrUpdateHostNameBinding({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: app.siteName,
          hostName: "alchemy-unverified.example.com",
          properties: { siteName: app.siteName, hostNameType: "Verified" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("HostNameVerificationFailed");
      expect(
        yield* bindingGone(
          group.resourceGroupName,
          app.siteName,
          "alchemy-unverified.example.com",
        ),
      ).toEqual("gone");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
