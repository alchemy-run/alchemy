import * as ACME from "@/ACME";
import * as Azure from "@/Azure";
import * as Cloudflare from "@/Cloudflare";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as signalr from "@distilled.cloud/azure/signalr";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { runPaidOnly } from "../gates.ts";
import { makeCertificateStack } from "./fixtures/certificate-stack.ts";
import {
  publicCertificate,
  resolvePublicZoneId,
  toPfxBase64,
} from "./fixtures/public-certificate.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(
    Azure.providers(),
    ACME.providers(),
    Cloudflare.providers(),
  ),
});

const getCertificate = (
  resourceGroupName: string,
  resourceName: string,
  certificateName: string,
) =>
  Effect.gen(function* () {
    return yield* signalr.GetSignalRCustomCertificate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      resourceName,
      certificateName,
    });
  });

const CERTIFICATE_LABEL = "azure-signalr-custom-certificate";

const program = (props: {
  zoneId: string;
  pfxBase64: string;
  secret: "A" | "B";
  pinVersion: boolean;
}) =>
  Effect.gen(function* () {
    const publicTls = yield* publicCertificate(props.zoneId, CERTIFICATE_LABEL);
    const base = yield* makeCertificateStack({ pfxBase64: props.pfxBase64 });
    const secret = base.secrets[props.secret];
    const certificate = yield* Azure.SignalR.CustomCertificate("Tls", {
      resourceGroup: base.group.resourceGroupName,
      signalR: base.signalRName,
      keyVaultBaseUri: base.vault.vaultUri,
      keyVaultSecretName: secret.secretName,
      keyVaultSecretVersion: props.pinVersion
        ? secret.secretUriWithVersion.pipe(
            Output.map((uri) => uri.split("/").pop()!),
          )
        : undefined,
    });
    return { ...base, publicTls, secret, certificate };
  });

// Premium_P1 unit (~$0.08/hour) for ~15 minutes, a vault and two secrets:
// ~$0.03 per run. Azure rejects self-signed certificates, so the test
// issues a free Let's Encrypt certificate through DNS-01 in the Cloudflare
// test zone. Runs only with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, replace, and delete a SignalR custom certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const zoneId = yield* resolvePublicZoneId;
      const issued = yield* stack.deploy(
        publicCertificate(zoneId, CERTIFICATE_LABEL),
      );
      const pfxBase64 = yield* toPfxBase64(issued.chain, issued.privateKey);

      const { group, service, secret, certificate } = yield* stack.deploy(
        program({ zoneId, pfxBase64, secret: "A", pinVersion: false }),
      );
      const get = (name: string) =>
        getCertificate(group.resourceGroupName, service.signalRName, name);
      expect(certificate.keyVaultSecretName).toEqual(secret.secretName);
      const observed = yield* get(certificate.certificateName);
      expect(observed.properties.keyVaultSecretName).toEqual(secret.secretName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");

      // Replacement: Azure rejects updating the secret version.
      const pinned = yield* stack.deploy(
        program({ zoneId, pfxBase64, secret: "A", pinVersion: true }),
      );
      expect(pinned.certificate.certificateName).not.toEqual(
        certificate.certificateName,
      );
      const pinnedObserved = yield* get(pinned.certificate.certificateName);
      expect(pinnedObserved.properties.provisioningState).toEqual("Succeeded");
      expect(pinnedObserved.properties.keyVaultSecretVersion).toBeDefined();
      expect(pinned.secret.secretUriWithVersion).toContain(
        pinnedObserved.properties.keyVaultSecretVersion!,
      );
      expect(yield* waitGone(get(certificate.certificateName))).toEqual("gone");

      // Replacement: the secret name is immutable.
      const replaced = yield* stack.deploy(
        program({ zoneId, pfxBase64, secret: "B", pinVersion: false }),
      );
      expect(replaced.certificate.certificateName).not.toEqual(
        pinned.certificate.certificateName,
      );
      const replacedObserved = yield* get(replaced.certificate.certificateName);
      expect(replacedObserved.properties.keyVaultSecretName).toEqual(
        replaced.secret.secretName,
      );
      expect(replacedObserved.properties.provisioningState).toEqual(
        "Succeeded",
      );
      expect(yield* waitGone(get(pinned.certificate.certificateName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(
          signalr.GetSignalR({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            resourceName: service.signalRName,
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe (Free_F1, free, ~2 minutes): tiers below Premium reject
// custom certificates with a typed error.
test.provider(
  "a non-Premium service rejects custom certificates with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, service } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "westus3",
          });
          const service = yield* Azure.SignalR.SignalR("Realtime", {
            resourceGroup: group.resourceGroupName,
          });
          return { group, service };
        }),
      );
      const error = yield* signalr
        .SignalRCustomCertificatesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          resourceName: service.signalRName,
          certificateName: "probe",
          properties: {
            keyVaultBaseUri: "https://example.vault.azure.net/",
            keyVaultSecretName: "probe",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SignalRSkuFeatureNotSupported");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
