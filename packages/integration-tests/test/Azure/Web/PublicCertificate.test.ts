import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import { CER_BASE64, PFX_THUMBPRINT } from "./fixtures/certificate.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getCertificate = (resourceGroupName: string, name: string, publicCertificateName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppPublicCertificate({
      subscriptionId,
      resourceGroupName,
      name,
      publicCertificateName,
    });
  });

const certificateGone = (resourceGroupName: string, name: string, publicCertificateName: string) =>
  getCertificate(resourceGroupName, name, publicCertificateName).pipe(
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

const program = (
  sku: string,
  cert:
    | {
        name: string | undefined;
        location: "CurrentUserMy" | "LocalMachineMy";
      }
    | undefined,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Public certificates need Windows. eastus has zero App Service quota;
    // westcentralus has F1/B1 quota, and Microsoft.Web throttles plan
    // creates per region for hours (AppServicePlanCreateThrottled), which the
    // other Web tests often trip in westus3, centralus and westus2.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westcentralus",
      sku,
      os: "windows",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "windows",
      siteConfig: { alwaysOn: false },
    });
    const publicCert =
      cert === undefined
        ? undefined
        : yield* Azure.Web.PublicCertificate("Ca", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            name: cert.name,
            blob: CER_BASE64,
            publicCertificateLocation: cert.location,
          });
    return { group, app, publicCert };
  });

// Free (F1) plans refuse public certificates, so the lifecycle needs a paid
// Basic (B1) plan: ~$0.018/h, under $0.01 per run. Provisioning: ~2-3 minutes.
test.provider.skipIf(!runPaidOnly)(
  "upload, replace, and delete a public certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program("B1", { name: undefined, location: "CurrentUserMy" }),
      );
      const { group, app } = created;
      const cert = created.publicCert!;
      expect(cert.thumbprint?.toUpperCase()).toEqual(PFX_THUMBPRINT);
      const observed = yield* getCertificate(
        group.resourceGroupName,
        app.siteName,
        cert.publicCertificateName,
      );
      expect(observed.properties?.publicCertificateLocation).toEqual("CurrentUserMy");

      // A redeploy with unchanged props keeps the certificate. The store is
      // the only mutable prop, and outside an App Service Environment
      // Microsoft.Web accepts only CurrentUserMy ("The parameter
      // publicCertificateLocation has an invalid value." for LocalMachineMy).
      const redeployed = yield* stack.deploy(
        program("B1", { name: undefined, location: "CurrentUserMy" }),
      );
      expect(redeployed.publicCert!.publicCertificateName).toEqual(cert.publicCertificateName);
      expect(redeployed.publicCert!.publicCertificateId).toEqual(cert.publicCertificateId);

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program("B1", {
          name: "alchemy-renamed-ca",
          location: "CurrentUserMy",
        }),
      );
      expect(replaced.publicCert!.publicCertificateName).toEqual("alchemy-renamed-ca");
      expect(
        yield* certificateGone(group.resourceGroupName, app.siteName, cert.publicCertificateName),
      ).toEqual("gone");

      // Delete only the certificate.
      yield* stack.deploy(program("B1", undefined));
      expect(
        yield* certificateGone(group.resourceGroupName, app.siteName, "alchemy-renamed-ca"),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 1_800_000,
  },
);

// Probe: an F1 app rejects a public certificate upload with a typed error
// (observed live: "Adding a Public Certificate failed because it would
// exceed the allowed amount of Free connections."). Cost: $0 (F1 plan).
test.provider(
  "free plan rejects a public certificate with WebPublicCertificateNotAllowedOnTier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, app } = yield* stack.deploy(program("F1", undefined));
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* web
        .WebAppsCreateOrUpdatePublicCertificate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: app.siteName,
          publicCertificateName: "alchemy-tier-probe",
          properties: {
            blob: CER_BASE64,
            publicCertificateLocation: "CurrentUserMy",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("WebPublicCertificateNotAllowedOnTier");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 1_800_000,
  },
);

const slotProgram = (installed: boolean) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Slots need a Standard (S1) Windows plan; westus2 accepts S1 plans.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "S1",
      os: "windows",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "windows",
      siteConfig: { alwaysOn: false },
    });
    const slot = yield* Azure.Web.WebAppSlot("Slot", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      name: "staging",
      siteConfig: { alwaysOn: false },
    });
    const publicCert = installed
      ? yield* Azure.Web.PublicCertificate("Ca", {
          resourceGroup: group.resourceGroupName,
          siteName: app.siteName,
          slot: slot.slotName,
          name: "alchemy-slot-ca",
          blob: CER_BASE64,
        })
      : undefined;
    return { group, app, publicCert };
  });

const getSlotCertificate = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppPublicCertificateSlot({
      subscriptionId,
      resourceGroupName,
      name,
      slot: "staging",
      publicCertificateName: "alchemy-slot-ca",
    });
  });

// S1 Windows plan: ~$0.10/h, about $0.02 per run. Provisioning: ~3 minutes.
test.provider(
  "upload and delete a public certificate on a deployment slot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app, publicCert } = yield* stack.deploy(slotProgram(true));
      expect(publicCert?.slot).toEqual("staging");
      expect(publicCert?.thumbprint?.toUpperCase()).toEqual(PFX_THUMBPRINT);
      const observed = yield* getSlotCertificate(group.resourceGroupName, app.siteName);
      expect(observed.properties?.thumbprint?.toUpperCase()).toEqual(PFX_THUMBPRINT);
      // The production slot does not get the certificate.
      expect(
        yield* certificateGone(group.resourceGroupName, app.siteName, "alchemy-slot-ca"),
      ).toEqual("gone");

      // Delete only the certificate.
      yield* stack.deploy(slotProgram(false));
      const after = yield* getSlotCertificate(group.resourceGroupName, app.siteName).pipe(
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
      expect(after).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
