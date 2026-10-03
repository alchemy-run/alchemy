import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as signalr from "@distilled.cloud/azure/signalr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { TEST_CERTIFICATE_DOMAIN } from "./fixtures/certificate.ts";
import { makeCertificateStack } from "./fixtures/certificate-stack.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDomain = (
  resourceGroupName: string,
  resourceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* signalr.GetSignalRCustomDomain({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      name,
    });
  });

/**
 * A custom domain needs a publicly resolvable CNAME
 * `{domain} → {signalRName}.service.signalr.net` and a certificate for the
 * domain, which the test subscription cannot provide on its own. Supply:
 * - `AZURE_TEST_SIGNALR_NAME`: fixed SignalR service name the CNAME targets
 * - `AZURE_TEST_SIGNALR_DOMAIN`: the domain (CNAME already in place)
 * - `AZURE_TEST_SIGNALR_DOMAIN_PFX`: base64 PFX (no password) for the domain
 */
const external = {
  name: process.env.AZURE_TEST_SIGNALR_NAME,
  domain: process.env.AZURE_TEST_SIGNALR_DOMAIN,
  pfx: process.env.AZURE_TEST_SIGNALR_DOMAIN_PFX,
};

const program = (domainName: string, secret: "A" | "B") =>
  Effect.gen(function* () {
    const base = yield* makeCertificateStack({
      signalRName: external.name,
      pfxBase64: external.pfx,
    });
    const certificates = {
      A: yield* Azure.SignalR.CustomCertificate("TlsA", {
        resourceGroup: base.group.resourceGroupName,
        signalR: base.signalRName,
        keyVaultBaseUri: base.vault.vaultUri,
        keyVaultSecretName: base.secrets.A.secretName,
      }),
      B: yield* Azure.SignalR.CustomCertificate("TlsB", {
        resourceGroup: base.group.resourceGroupName,
        signalR: base.signalRName,
        keyVaultBaseUri: base.vault.vaultUri,
        keyVaultSecretName: base.secrets.B.secretName,
      }),
    };
    const domain = yield* Azure.SignalR.CustomDomain("Domain", {
      resourceGroup: base.group.resourceGroupName,
      signalR: base.signalRName,
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
  "create, update, and delete a SignalR custom domain",
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
          service.signalRName,
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

// Ungated probe (Free_F1, free, ~2 minutes): tiers below Premium reject
// custom domains with a typed error.
test.provider(
  "a non-Premium service rejects custom domains with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "centralus",
          });
          const service = yield* Azure.SignalR.SignalR("Realtime", {
            resourceGroup: group.resourceGroupName,
          });
          return { group, service };
        }),
      );
      const error = yield* signalr
        .SignalRCustomDomainsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          resourceName: service.signalRName,
          name: "probe",
          properties: {
            domainName: TEST_CERTIFICATE_DOMAIN,
            customCertificate: {
              id: `${service.signalRId}/customCertificates/probe`,
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SignalRSkuFeatureNotSupported");
      expect(
        yield* waitGone(
          getDomain(group.resourceGroupName, service.signalRName, "probe"),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
