import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  PFX_BASE64,
  PFX_PASSWORD,
  PFX_THUMBPRINT,
} from "./fixtures/certificate.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getCertificate = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetCertificate({
      subscriptionId,
      resourceGroupName,
      name,
    });
  });

const certificateGone = (resourceGroupName: string, name: string) =>
  getCertificate(resourceGroupName, name).pipe(
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

const program = (props: { location: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cert = yield* Azure.Web.Certificate("Tls", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      pfxBlob: Redacted.make(PFX_BASE64),
      password: Redacted.make(PFX_PASSWORD),
      tags: props.tags,
    });
    return { group, cert };
  });

// Cost: $0 (uploaded certificates are free; no plan required). Provisioning:
// seconds.
test.provider(
  "upload, update, replace, and delete an app service certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cert } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      expect(cert.thumbprint.toUpperCase()).toEqual(PFX_THUMBPRINT);
      expect(cert.subjectName).toContain("alchemy-test.example.com");
      expect(cert.hostNames).toContain("alchemy-test.example.com");
      const observed = yield* getCertificate(
        group.resourceGroupName,
        cert.certificateName,
      );
      expect(observed.properties?.thumbprint?.toUpperCase()).toEqual(
        PFX_THUMBPRINT,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Tls");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "prod" } }),
      );
      expect(updated.cert.certificateName).toEqual(cert.certificateName);
      const retagged = yield* getCertificate(
        group.resourceGroupName,
        cert.certificateName,
      );
      expect(retagged.tags?.env).toEqual("prod");

      // Replacement: the location cannot change in place.
      const replaced = yield* stack.deploy(
        program({ location: "centralus", tags: { env: "prod" } }),
      );
      expect(replaced.cert.certificateName).not.toEqual(cert.certificateName);
      const moved = yield* getCertificate(
        group.resourceGroupName,
        replaced.cert.certificateName,
      );
      expect(moved.location.toLowerCase().replaceAll(" ", "")).toEqual(
        "centralus",
      );
      expect(
        yield* certificateGone(group.resourceGroupName, cert.certificateName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* certificateGone(
          group.resourceGroupName,
          replaced.cert.certificateName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
