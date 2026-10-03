import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  PFX_BASE64,
  PFX_PASSWORD,
  PFX_THUMBPRINT,
} from "./fixtures/certificate.ts";
import {
  CONSUMPTION_PROFILES,
  logLevel,
  STANDARD_LOCATION,
  waitGone,
  withStandardEnvironment,
} from "./fixtures/shared.ts";
import { runExpensive } from "../gates.ts";

const LOCATION = STANDARD_LOCATION;

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  environmentName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetCertificate({
      subscriptionId,
      resourceGroupName,
      environmentName,
      certificateName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const cert = yield* Azure.ContainerApps.Certificate("Cert", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      name: props.name,
      value: Redacted.make(PFX_BASE64),
      password: Redacted.make(PFX_PASSWORD),
      tags: props.tags,
    });
    return { group, env, cert };
  });

// Cost: Consumption environment (free idle); certificates are free (~$0).
// Gated (time, not cost): the trial allows one standard environment per
// subscription, so these lifecycles serialize behind
// `withStandardEnvironment`, and an environment delete takes 5-25 minutes
// (~15-35 minutes per test). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "upload, retag, replace, and delete an environment certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, cert } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(cert.thumbprint?.toUpperCase()).toEqual(PFX_THUMBPRINT);
      expect(cert.subjectName).toContain("alchemy-test.example.com");
      expect(cert.location.toLowerCase().replaceAll(" ", "")).toEqual(LOCATION);

      const observed = yield* getCertificate(
        group.resourceGroupName,
        env.environmentName,
        cert.certificateName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cert");

      // In-place update: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.cert.certificateId).toEqual(cert.certificateId);
      const reobserved = yield* getCertificate(
        group.resourceGroupName,
        env.environmentName,
        cert.certificateName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name uploads a new certificate.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-test-cert-two", tags: { env: "prod" } }),
      );
      expect(replaced.cert.certificateName).toEqual("alchemy-test-cert-two");
      expect(
        yield* waitGone(
          getCertificate(
            group.resourceGroupName,
            env.environmentName,
            cert.certificateName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCertificate(
            group.resourceGroupName,
            env.environmentName,
            replaced.cert.certificateName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
