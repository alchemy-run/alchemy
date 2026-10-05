import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Output from "@/Output";
import {
  CONSUMPTION_PROFILES,
  logLevel,
  QUICKSTART_IMAGE,
  STANDARD_LOCATION,
  waitGone,
  withStandardEnvironment,
} from "./fixtures/shared.ts";
import { runExpensive } from "../gates.ts";

const LOCATION = STANDARD_LOCATION;

/**
 * A hostname you control whose DNS already points at the test app: a CNAME
 * to the app's FQDN and an `asuid.{host}` TXT record with the environment's
 * custom domain verification ID. Without it the certificate can never be
 * issued, so the lifecycle only runs when it is set.
 */
const CUSTOM_DOMAIN = process.env.AZURE_TEST_CUSTOM_DOMAIN;

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  environmentName: string,
  managedCertificateName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetManagedCertificate({
      subscriptionId,
      resourceGroupName,
      environmentName,
      managedCertificateName,
    });
  });

const program = (hostname: string, tags: Record<string, string>) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const env = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      workloadProfiles: CONSUMPTION_PROFILES,
    });
    const web = yield* Azure.ContainerApps.ContainerApp("Web", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      environmentId: env.environmentId,
      configuration: {
        ingress: {
          external: true,
          targetPort: 80,
          customDomains: [{ name: hostname, bindingType: "Disabled" }],
        },
      },
      template: {
        containers: [
          {
            name: "web",
            image: QUICKSTART_IMAGE,
            resources: { cpu: 0.25, memory: "0.5Gi" },
          },
        ],
        scale: { minReplicas: 0, maxReplicas: 1 },
      },
    });
    const cert = yield* Azure.ContainerApps.ManagedCertificate("Cert", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      // Issue only after the app has the hostname bound.
      subjectName: Output.map(web.containerAppName, () => hostname),
      domainControlValidation: "CNAME",
      tags,
    });
    return { group, env, web, cert };
  });

// Cost: free certificate + Consumption environment (~$0). Requires a real
// domain with DNS records in place (AZURE_TEST_CUSTOM_DOMAIN); issuance
// takes 5-20 minutes on top of the ~15-35 minute environment lifecycle.
// Gated (time + external DNS): run with AZURE_TEST_EXPENSIVE=1 and
// AZURE_TEST_CUSTOM_DOMAIN set.
test.provider.skipIf(!runExpensive || !CUSTOM_DOMAIN)(
  "issue, retag, and delete a managed certificate",
  (stack) =>
    Effect.gen(function* () {
      const hostname = CUSTOM_DOMAIN ?? "";
      yield* stack.destroy();

      const { group, env, cert } = yield* stack.deploy(
        program(hostname, { env: "test" }),
      );
      expect(cert.subjectName).toEqual(hostname);
      expect(cert.provisioningState).toEqual("Succeeded");
      const get = getCertificate(
        group.resourceGroupName,
        env.environmentName,
        cert.certificateName,
      );
      expect((yield* get).tags?.env).toEqual("test");

      // In-place update: tags.
      const updated = yield* stack.deploy(program(hostname, { env: "prod" }));
      expect(updated.cert.certificateId).toEqual(cert.certificateId);
      expect((yield* get).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(withStandardEnvironment, logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 3_600_000,
  },
);
