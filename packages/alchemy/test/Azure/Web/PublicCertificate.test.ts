import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
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
    // Public certificates need Windows; F1 quota exists only in centralus.
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

// Cost: $0 (F1 Free plan). Provisioning: ~2-3 minutes.
test.provider(
  "upload, update, replace, and delete a public certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ name: undefined, location: "CurrentUserMy" }),
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
        program({ name: undefined, location: "LocalMachineMy" }),
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
        program({ name: "alchemy-renamed-ca", location: "LocalMachineMy" }),
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
      yield* stack.deploy(program(undefined));
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
