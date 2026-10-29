import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { CERT_A_PEM, KEY_A_PEM } from "../../Compute/fixtures/https-proxy-cert.ts";

/** CertificateManager resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeCertificateMap = GCP.CertificateManager.CertificateMap("ProbeCertificateMap", {
  location: "global",
  description: "frontend map a",
});

export const ProbeDnsAuthorization = GCP.CertificateManager.DnsAuthorization(
  "ProbeDnsAuthorization",
  {
    location: "global",
    domain: "probe.alchemy-cm.example.com",
  },
);
export const ProbeTrustConfig = GCP.CertificateManager.TrustConfig("ProbeTrustConfig", {
  location: "global",
  trustStores: [{ trustAnchors: [{ pemCertificate: CERT_A_PEM }] }],
});

export const ProbeCertificate = GCP.CertificateManager.Certificate("ProbeCertificate", {
  location: "global",
  pemCertificate: CERT_A_PEM,
  pemPrivateKey: KEY_A_PEM,
});
export const ProbeMapEntry = Effect.gen(function* () {
  const map = yield* ProbeCertificateMap;
  const cert = yield* ProbeCertificate;
  return yield* GCP.CertificateManager.CertificateMapEntry("ProbeMapEntry", {
    certificateMap: map.name,
    certificates: [cert.name],
    hostname: "alchemy-ssl-a.test",
  });
});
