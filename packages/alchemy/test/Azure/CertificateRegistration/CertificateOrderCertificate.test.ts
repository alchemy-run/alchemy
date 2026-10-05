import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as certificateregistration from "@distilled.cloud/azure/certificateregistration";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive, runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCertificate = (
  resourceGroupName: string,
  certificateOrderName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* certificateregistration.GetAppServiceCertificateOrderCertificate(
      {
        subscriptionId: yield* subscription,
        resourceGroupName,
        certificateOrderName,
        name,
      },
    );
  });

const program = (props: { secretName: string; certificateName?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const order = yield* Azure.CertificateRegistration.CertificateOrder(
      "Order",
      {
        resourceGroup: group.resourceGroupName,
        productType: "StandardDomainValidatedSsl",
        distinguishedName: "CN=alchemy-test-cert.example.com",
        autoRenew: false,
      },
    );
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const certificate =
      yield* Azure.CertificateRegistration.CertificateOrderCertificate(
        "Certificate",
        {
          resourceGroup: group.resourceGroupName,
          certificateOrder: order.certificateOrderName,
          name: props.certificateName,
          keyVaultId: vault.vaultId,
          keyVaultSecretName: props.secretName,
          tags: { env: "test" },
        },
      );
    return { group, order, vault, certificate };
  });

// Needs a purchased App Service Certificate order (~$69.99, non-refundable
// after the cancellation window); free-trial subscriptions cannot buy one.
// The order is never issued (no domain verification), so the link stays
// `WaitingOnCertificateOrder`. Needs AZURE_TEST_PAID=1 and
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runPaidOnly || !runExpensive)(
  "create, update, replace, and delete a certificate order certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, order, vault, certificate } = yield* stack.deploy(
        program({ secretName: "alchemy-cert-a" }),
      );
      const get = (name: string) =>
        getCertificate(
          group.resourceGroupName,
          order.certificateOrderName,
          name,
        );
      const observed = yield* get(certificate.certificateName);
      expect(observed.properties?.keyVaultId?.toLowerCase()).toEqual(
        vault.vaultId.toLowerCase(),
      );
      expect(observed.properties?.keyVaultSecretName).toEqual("alchemy-cert-a");
      expect(observed.tags?.env).toEqual("test");

      // In-place: point the link at another secret.
      const updated = yield* stack.deploy(
        program({ secretName: "alchemy-cert-b" }),
      );
      expect(updated.certificate.certificateId).toEqual(
        certificate.certificateId,
      );
      const reobserved = yield* get(certificate.certificateName);
      expect(reobserved.properties?.keyVaultSecretName).toEqual(
        "alchemy-cert-b",
      );

      // Replacement: the certificate name is immutable.
      const replaced = yield* stack.deploy(
        program({ secretName: "alchemy-cert-b", certificateName: "renamed" }),
      );
      expect(replaced.certificate.certificateName).toEqual("renamed");
      const replacedObserved = yield* get("renamed");
      expect(replacedObserved.properties?.keyVaultSecretName).toEqual(
        "alchemy-cert-b",
      );
      expect(yield* waitGone(get(certificate.certificateName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
