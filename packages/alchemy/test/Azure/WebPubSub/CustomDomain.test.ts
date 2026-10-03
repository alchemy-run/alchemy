import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { TEST_CERTIFICATE_DOMAIN } from "./fixtures/certificate.ts";
import {
  certificateStack,
  makeCertificateStack,
} from "./fixtures/certificate-stack.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDomain = (
  resourceGroupName: string,
  resourceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* webpubsub.GetWebPubSubCustomDomain({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      name,
    });
  });

/**
 * A custom domain needs a publicly resolvable CNAME
 * `{domain} → {webPubSubName}.webpubsub.azure.com` and a certificate for the
 * domain, which the test subscription cannot provide on its own. Supply:
 * - `AZURE_TEST_WEBPUBSUB_NAME`: fixed Web PubSub service name the CNAME targets
 * - `AZURE_TEST_WEBPUBSUB_DOMAIN`: the domain (CNAME already in place)
 * - `AZURE_TEST_WEBPUBSUB_DOMAIN_PFX`: base64 PFX (no password) for the domain
 */
const external = {
  name: process.env.AZURE_TEST_WEBPUBSUB_NAME,
  domain: process.env.AZURE_TEST_WEBPUBSUB_DOMAIN,
  pfx: process.env.AZURE_TEST_WEBPUBSUB_DOMAIN_PFX,
};

const program = (domainName: string, secret: "A" | "B") =>
  Effect.gen(function* () {
    const base = yield* makeCertificateStack({
      webPubSubName: external.name,
      pfxBase64: external.pfx,
    });
    const certificates = {
      A: yield* Azure.WebPubSub.CustomCertificate("TlsA", {
        resourceGroup: base.group.resourceGroupName,
        webPubSub: base.webPubSubName,
        keyVaultBaseUri: base.vault.vaultUri,
        keyVaultSecretName: base.secrets.A.secretName,
      }),
      B: yield* Azure.WebPubSub.CustomCertificate("TlsB", {
        resourceGroup: base.group.resourceGroupName,
        webPubSub: base.webPubSubName,
        keyVaultBaseUri: base.vault.vaultUri,
        keyVaultSecretName: base.secrets.B.secretName,
      }),
    };
    const domain = yield* Azure.WebPubSub.CustomDomain("Domain", {
      resourceGroup: base.group.resourceGroupName,
      webPubSub: base.webPubSubName,
      domainName,
      customCertificateId: certificates[secret].certificateId,
    });
    return { ...base, certificates, domain };
  });

// Premium_P1 unit (~$0.08/hour) for ~15 minutes plus an externally owned
// domain: needs-external-systems, so the lifecycle only runs with
// AZURE_TEST_PAID=1 and the three variables above.
test.provider.skipIf(
  !runPaidOnly || !external.name || !external.domain || !external.pfx,
)(
  "create, update, and delete a Web PubSub custom domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const domainName = external.domain!;

      const { group, service, certificates, domain } = yield* stack.deploy(
        program(domainName, "A"),
      );
      const get = () =>
        getDomain(
          group.resourceGroupName,
          service.webPubSubName,
          domain.customDomainName,
        );
      const observed = yield* get();
      expect(observed.properties.domainName).toEqual(domainName);
      expect(observed.properties.customCertificate.id?.toLowerCase()).toEqual(
        certificates.A.certificateId.toLowerCase(),
      );

      // In place: switch to the second certificate.
      const updated = yield* stack.deploy(program(domainName, "B"));
      expect(updated.domain.customDomainId).toEqual(domain.customDomainId);
      const reobserved = yield* get();
      expect(reobserved.properties.customCertificate.id?.toLowerCase()).toEqual(
        certificates.B.certificateId.toLowerCase(),
      );

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (Premium_P1 for ~8 minutes, ~$0.02): without a CNAME to the
// service, Azure rejects the custom domain with a typed error.
test.provider(
  "a custom domain without a CNAME is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service, certificate } = yield* stack.deploy(
        Effect.gen(function* () {
          const base = yield* certificateStack;
          const certificate = yield* Azure.WebPubSub.CustomCertificate("Tls", {
            resourceGroup: base.group.resourceGroupName,
            webPubSub: base.webPubSubName,
            keyVaultBaseUri: base.vault.vaultUri,
            keyVaultSecretName: base.secrets.A.secretName,
          });
          return { ...base, certificate };
        }),
      );
      const error = yield* webpubsub
        .WebPubSubCustomDomainsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          resourceName: service.webPubSubName,
          name: "probe",
          properties: {
            domainName: TEST_CERTIFICATE_DOMAIN,
            customCertificate: { id: certificate.certificateId },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SignalRCustomDomainCnameMissing");
      expect(
        yield* waitGone(
          getDomain(group.resourceGroupName, service.webPubSubName, "probe"),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
