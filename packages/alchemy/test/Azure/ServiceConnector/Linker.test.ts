import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as servicelinker from "@distilled.cloud/azure/servicelinker";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getLinker = (attrs: { source: string; linkerName: string }) =>
  servicelinker.GetLinker({
    resourceUri: attrs.source,
    linkerName: attrs.linkerName,
  });

const linkerGone = (attrs: { source: string; linkerName: string }) =>
  getLinker(attrs).pipe(
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

const LOCATION = "eastus";

/** App settings Service Connector wrote into the web app. */
const appSettings = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const settings = yield* web.ListWebAppApplicationSettings({
      subscriptionId,
      resourceGroupName,
      name,
    });
    return Object.keys(settings.properties ?? {});
  });

// Container Apps sources are not used: Service Connector fails Express
// environments server-side (`InternalProcessingError: Object reference not
// set to an instance of an object`) and Consumption environments compete for
// the subscription's single standard-environment slot.
const program = (props: {
  service: "blobServices" | "queueServices";
  customizedKeys?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    // The free trial has F1 quota in westus3 (eastus has none; centralus
    // plan creates are throttled subscription-wide).
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      sku: "F1",
      os: "linux",
    });
    const site = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "linux",
      siteConfig: { linuxFxVersion: "NODE|20-lts", alwaysOn: false },
    });
    const account = yield* Azure.Storage.StorageAccount("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const linker = yield* Azure.ServiceConnector.Linker("Linker", {
      source: site.siteId,
      targetService: {
        type: "AzureResource",
        id: Output.interpolate`${account.storageAccountId}/${props.service}/default`,
      },
      authInfo: { authType: "secret" },
      clientType: "nodejs",
      configurationInfo: {
        customizedKeys: props.customizedKeys,
        deleteOrUpdateBehavior: "ForcedCleanup",
      },
    });
    return { group, site, account, linker };
  });

// Cost: $0 (F1 Free plan + empty Standard_LRS account). ~3-5 minutes.
test.provider(
  "create, update, replace, and delete a service connector linker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site, account, linker } = yield* stack.deploy(
        program({ service: "blobServices" }),
      );
      expect(linker.linkerName).toMatch(/^[A-Za-z0-9._]+$/);
      expect(linker.source).toEqual(site.siteId);
      expect(linker.target.toLowerCase()).toEqual(
        `${account.storageAccountId}/blobServices/default`.toLowerCase(),
      );
      const observed = yield* getLinker(linker);
      expect(observed.properties.clientType).toEqual("nodejs");
      expect(observed.properties.authInfo?.authType).toEqual("secret");
      expect(
        yield* appSettings(group.resourceGroupName, site.siteName),
      ).toContain("AZURE_STORAGEBLOB_CONNECTIONSTRING");

      // In-place update: rename the generated app setting.
      const updated = yield* stack.deploy(
        program({
          service: "blobServices",
          customizedKeys: { AZURE_STORAGEBLOB_CONNECTIONSTRING: "BLOB_CONN" },
        }),
      );
      expect(updated.linker.linkerName).toEqual(linker.linkerName);
      expect(
        yield* appSettings(group.resourceGroupName, site.siteName),
      ).toContain("BLOB_CONN");

      // Replacement: a different target is a new connection.
      const replaced = yield* stack.deploy(
        program({ service: "queueServices" }),
      );
      expect(replaced.linker.linkerName).not.toEqual(linker.linkerName);
      expect(replaced.linker.target.toLowerCase()).toContain(
        "/queueservices/default",
      );
      expect(yield* linkerGone(linker)).toEqual("gone");
      expect(
        yield* appSettings(group.resourceGroupName, site.siteName),
      ).toContain("AZURE_STORAGEQUEUE_CONNECTIONSTRING");

      yield* stack.destroy();
      expect(yield* linkerGone(replaced.linker)).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:serviceconnector", "live"],
    timeout: 900_000,
  },
);
