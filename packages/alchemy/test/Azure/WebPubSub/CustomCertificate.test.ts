import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import {
  certificateStack,
  makeCertificateStack,
} from "./fixtures/certificate-stack.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  resourceName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    return yield* webpubsub.GetWebPubSubCustomCertificate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      certificateName,
    });
  });

const program = (props: { secret: "A" | "B"; pinVersion: boolean }) =>
  Effect.gen(function* () {
    const base = yield* makeCertificateStack({ pfxBase64: externalPfx });
    const secret = base.secrets[props.secret];
    const certificate = yield* Azure.WebPubSub.CustomCertificate("Tls", {
      resourceGroup: base.group.resourceGroupName,
      webPubSub: base.webPubSubName,
      keyVaultBaseUri: base.vault.vaultUri,
      keyVaultSecretName: secret.secretName,
      keyVaultSecretVersion: props.pinVersion
        ? secret.secretUriWithVersion.pipe(
            Output.map((uri) => uri.split("/").pop()!),
          )
        : undefined,
    });
    return { ...base, secret, certificate };
  });

/**
 * Web PubSub rejects self-signed certificates ("Custom certificate not
 * valid: Self-signed certificate is not supported."), so the lifecycle needs
 * a CA-signed PFX the test subscription cannot mint on its own:
 * - `AZURE_TEST_WEBPUBSUB_CERT_PFX`: base64 PFX (no password), CA-signed
 */
const externalPfx = process.env.AZURE_TEST_WEBPUBSUB_CERT_PFX;

// Premium_P1 unit (~$0.07/hour) for ~10 minutes, a vault and two secrets:
// ~$0.02 per run, but needs-external-systems (a CA-signed certificate), so it
// only runs with AZURE_TEST_PAID=1 and the variable above.
test.provider.skipIf(!runPaidOnly || !externalPfx)(
  "create, update, replace, and delete a Web PubSub custom certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, secret, certificate } = yield* stack.deploy(
        program({ secret: "A", pinVersion: false }),
      );
      const get = (name: string) =>
        getCertificate(group.resourceGroupName, service.webPubSubName, name);
      expect(certificate.keyVaultSecretName).toEqual(secret.secretName);
      const observed = yield* get(certificate.certificateName);
      expect(observed.properties.keyVaultSecretName).toEqual(secret.secretName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");

      // In place: pin the secret version.
      const updated = yield* stack.deploy(
        program({ secret: "A", pinVersion: true }),
      );
      expect(updated.certificate.certificateId).toEqual(
        certificate.certificateId,
      );
      const reobserved = yield* get(certificate.certificateName);
      expect(reobserved.properties.keyVaultSecretVersion).toBeDefined();
      expect(updated.secret.secretUriWithVersion).toContain(
        reobserved.properties.keyVaultSecretVersion!,
      );

      // Replacement: the secret name is immutable.
      const replaced = yield* stack.deploy(
        program({ secret: "B", pinVersion: false }),
      );
      expect(replaced.certificate.certificateName).not.toEqual(
        certificate.certificateName,
      );
      const replacedObserved = yield* get(replaced.certificate.certificateName);
      expect(replacedObserved.properties.keyVaultSecretName).toEqual(
        replaced.secret.secretName,
      );
      expect(yield* waitGone(get(certificate.certificateName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          webpubsub.GetWebPubSub({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            resourceName: service.webPubSubName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (Premium_P1 for ~5 minutes, ~$0.01): the checked-in
// self-signed certificate is accepted by the PUT but the service fails to
// load it, leaving the certificate in provisioning state `Failed`.
test.provider(
  "a self-signed custom certificate ends in provisioning state Failed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, vault, secrets } =
        yield* stack.deploy(certificateStack);
      yield* webpubsub.WebPubSubCustomCertificatesCreateOrUpdate({
        subscriptionId: yield* subscription,
        resourceGroupName: group.resourceGroupName,
        resourceName: service.webPubSubName,
        certificateName: "probe",
        properties: {
          keyVaultBaseUri: vault.vaultUri,
          keyVaultSecretName: secrets.A.secretName,
        },
      });
      const settled = yield* getCertificate(
        group.resourceGroupName,
        service.webPubSubName,
        "probe",
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (certificate) =>
            certificate.properties.provisioningState === "Failed" ||
            certificate.properties.provisioningState === "Succeeded",
          times: 60,
        }),
      );
      expect(settled.properties.provisioningState).toEqual("Failed");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          webpubsub.GetWebPubSub({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            resourceName: service.webPubSubName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
