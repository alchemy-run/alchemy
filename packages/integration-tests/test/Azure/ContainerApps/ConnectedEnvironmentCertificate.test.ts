import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import { PFX_BASE64, PFX_PASSWORD, PFX_THUMBPRINT } from "./fixtures/certificate.ts";
import {
  connectedEnvironmentStack,
  MISSING_ENVIRONMENT,
  probeGroup,
} from "./fixtures/connected.ts";
import { logLevel, waitGone } from "./fixtures/shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:containerapps", "live"];

const getCertificate = (
  resourceGroupName: string,
  connectedEnvironmentName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetConnectedEnvironmentsCertificate({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
      certificateName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, env } = yield* connectedEnvironmentStack;
    const cert = yield* Azure.ContainerApps.ConnectedEnvironmentCertificate("Tls", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      name: props.name,
      value: Redacted.make(PFX_BASE64),
      password: Redacted.make(PFX_PASSWORD),
      tags: props.tags,
    });
    return { group, env, cert };
  });

// ~cluster cost only, 20 min. Needs an Arc-enabled Kubernetes cluster with
// the Container Apps extension and a custom location (see
// fixtures/connected.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a connected environment certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, cert } = yield* stack.deploy(program({ tags: { env: "test" } }));
      expect(cert.thumbprint?.toUpperCase()).toEqual(PFX_THUMBPRINT);
      expect(cert.subjectName).toContain("alchemy-test.example.com");
      const get = (name: string) =>
        getCertificate(group.resourceGroupName, env.environmentName, name);
      const observed = yield* get(cert.certificateName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In-place update: tags (PATCH).
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.cert.certificateId).toEqual(cert.certificateId);
      expect((yield* get(cert.certificateName)).tags?.env).toEqual("prod");

      // Replacement: a new name uploads a new certificate.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-arc-tls-two", tags: { env: "prod" } }),
      );
      expect(replaced.cert.certificateName).toEqual("alchemy-arc-tls-two");
      expect(yield* waitGone(get(cert.certificateName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-arc-tls-two"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe (free, a resource group only): a certificate under a
// missing connected environment is rejected with the typed error.
test.provider(
  "a missing connected environment rejects the certificate with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const error = yield* app
        .ConnectedEnvironmentsCertificatesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          connectedEnvironmentName: MISSING_ENVIRONMENT,
          certificateName: "probe",
          location: "eastus",
          properties: { value: PFX_BASE64, password: PFX_PASSWORD },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      // Through the provider: reconcile observes nothing, PUTs, and
      // surfaces the same typed error.
      const deployError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const probe = yield* probeGroup;
            const cert = yield* Azure.ContainerApps.ConnectedEnvironmentCertificate("Tls", {
              resourceGroup: probe.group.resourceGroupName,
              environment: MISSING_ENVIRONMENT,
              location: "eastus",
              value: Redacted.make(PFX_BASE64),
              password: Redacted.make(PFX_PASSWORD),
            });
            return { cert };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
