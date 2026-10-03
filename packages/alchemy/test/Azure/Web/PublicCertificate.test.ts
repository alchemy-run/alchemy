import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import { f1PlanCreateRejection } from "./fixtures/f1-plan.ts";
import { CER_BASE64, PFX_THUMBPRINT } from "./fixtures/certificate.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getCertificate = (
  resourceGroupName: string,
  name: string,
  publicCertificateName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppPublicCertificate({
      subscriptionId,
      resourceGroupName,
      name,
      publicCertificateName,
    });
  });

const certificateGone = (
  resourceGroupName: string,
  name: string,
  publicCertificateName: string,
) =>
  getCertificate(resourceGroupName, name, publicCertificateName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
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
    // Public certificates need Windows. F1 quota exists in westus3
    // (centralus plan creates are throttled).
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
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

// Free (F1) plans refuse public certificates and the free trial has zero
// Basic (B1) quota, so the lifecycle needs a paid subscription. Cost there:
// B1 ~$0.018/h, under $0.01 per run. Provisioning: ~2-3 minutes.
test.provider.skipIf(!runPaidOnly)(
  "upload, update, replace, and delete a public certificate",
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
      expect(observed.properties?.publicCertificateLocation).toEqual(
        "CurrentUserMy",
      );

      // In-place update: the certificate store.
      const updated = yield* stack.deploy(
        program("B1", { name: undefined, location: "LocalMachineMy" }),
      );
      expect(updated.publicCert!.publicCertificateName).toEqual(
        cert.publicCertificateName,
      );
      const moved = yield* getCertificate(
        group.resourceGroupName,
        app.siteName,
        cert.publicCertificateName,
      );
      expect(moved.properties?.publicCertificateLocation).toEqual(
        "LocalMachineMy",
      );

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program("B1", {
          name: "alchemy-renamed-ca",
          location: "LocalMachineMy",
        }),
      );
      expect(replaced.publicCert!.publicCertificateName).toEqual(
        "alchemy-renamed-ca",
      );
      expect(
        yield* certificateGone(
          group.resourceGroupName,
          app.siteName,
          cert.publicCertificateName,
        ),
      ).toEqual("gone");

      // Delete only the certificate.
      yield* stack.deploy(program("B1", undefined));
      expect(
        yield* certificateGone(
          group.resourceGroupName,
          app.siteName,
          "alchemy-renamed-ca",
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

// Probe: an F1 app rejects a public certificate upload with a typed error
// (observed live: "Adding a Public Certificate failed because it would
// exceed the allowed amount of Free connections."). It needs a fresh F1
// plan, and F1 plan creates are throttled for the subscription (see
// fixtures/f1-plan.ts), so it runs only with AZURE_TEST_PAID=1 for now.
test.provider.skipIf(!runPaidOnly)(
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
    timeout: 600_000,
  },
);

// Probe: F1 plan creates are throttled for the subscription (see
// fixtures/f1-plan.ts).
test.provider(
  "F1 plan create is rejected with AppServicePlanCreateThrottled",
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
      const error = yield* f1PlanCreateRejection(group.resourceGroupName);
      expect(error._tag).toEqual("AppServicePlanCreateThrottled");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
