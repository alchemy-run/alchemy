import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { PFX_BASE64, PFX_PASSWORD, PFX_THUMBPRINT } from "./fixtures/certificate.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getCertificate = (
  resourceGroupName: string,
  name: string,
  certificateName: string,
  slot?: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = { subscriptionId, resourceGroupName, name, certificateName };
    return slot === undefined
      ? yield* web.GetSiteCertificate(where)
      : yield* web.GetSiteCertificateSlot({ ...where, slot });
  });

const certificateGone = (
  resourceGroupName: string,
  name: string,
  certificateName: string,
  slot?: string,
) =>
  getCertificate(resourceGroupName, name, certificateName, slot).pipe(
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

const program = (cert: { tags: Record<string, string>; slot: boolean } | undefined) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Site certificates need Basic+ and slots Standard; eastus has zero App
    // Service quota, westus2 accepts S1 plans.
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
    const certificate =
      cert === undefined
        ? undefined
        : yield* Azure.Web.SiteCertificate("Tls", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            slot: cert.slot ? slot.slotName : undefined,
            location: "westus2",
            pfxBlob: Redacted.make(PFX_BASE64),
            password: Redacted.make(PFX_PASSWORD),
            tags: cert.tags,
          });
    return { group, app, certificate };
  });

// S1 plan: ~$0.10/h, about $0.02 per run. Provisioning: ~3 minutes.
// Skipped: SiteCertificatesCreateOrUpdate answers `WebMethodNotImplemented`
// "The requested method is not implemented." (observed 2026-10-23, S1 Linux
// app in westus2); the probe below pins it.
test.provider.skip(
  "upload, retag, move to a slot, and delete a site certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, app, certificate } = yield* stack.deploy(
        program({ tags: { env: "test" }, slot: false }),
      );
      const name = certificate?.certificateName ?? "";
      expect(certificate?.thumbprint.toUpperCase()).toEqual(PFX_THUMBPRINT);
      const observed = yield* getCertificate(group.resourceGroupName, app.siteName, name);
      expect(observed.properties?.thumbprint?.toUpperCase()).toEqual(PFX_THUMBPRINT);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Tls");

      // In-place update: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" }, slot: false }));
      expect(updated.certificate?.certificateId).toEqual(certificate?.certificateId);
      const retagged = yield* getCertificate(group.resourceGroupName, app.siteName, name);
      expect(retagged.tags?.env).toEqual("prod");

      // Replacement: move the certificate to the staging slot.
      const moved = yield* stack.deploy(program({ tags: { env: "prod" }, slot: true }));
      expect(moved.certificate?.slot).toEqual("staging");
      const inSlot = yield* getCertificate(group.resourceGroupName, app.siteName, name, "staging");
      expect(inSlot.properties?.thumbprint?.toUpperCase()).toEqual(PFX_THUMBPRINT);
      expect(yield* certificateGone(group.resourceGroupName, app.siteName, name)).toEqual("gone");

      // Delete only the certificate.
      yield* stack.deploy(program(undefined));
      expect(
        yield* certificateGone(group.resourceGroupName, app.siteName, name, "staging"),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

// Probe: Microsoft.Web does not implement app-scoped certificate uploads.
// S1 plan: ~$0.10/h, under $0.01 per run. Provisioning: ~2 minutes.
test.provider(
  "a site certificate upload is rejected with WebMethodNotImplemented",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, app } = yield* stack.deploy(program(undefined));
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* web
        .SiteCertificatesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          name: app.siteName,
          certificateName: "alchemy-probe",
          location: "westus2",
          properties: { pfxBlob: PFX_BASE64, password: PFX_PASSWORD },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("WebMethodNotImplemented");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
