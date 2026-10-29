import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { CERT_A_PEM, KEY_A_PEM } from "../../Compute/fixtures/https-proxy-cert.ts";

/** A self-signed CA the trust config anchors (the TrustConfig suite's). */
const TRUST_ANCHOR = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgIUY07uz+vKYeBK3NYMhk03eWyTPKkwDQYJKoZIhvcNAQEL
BQAwHTEbMBkGA1UEAwwSYWxjaGVteS1zc2wtYS50ZXN0MB4XDTI2MDgyNDE1NDM0
NFoXDTM2MDgyMTE1NDM0NFowHTEbMBkGA1UEAwwSYWxjaGVteS1zc2wtYS50ZXN0
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzUAYVVO5iOluteYkxOqA
bBF+EnWrtfsUMoPJPXBEIrmT66G+vx+rArDsRxJqnWr9YstEQKsHtkErGF37avZr
12jTIiKWk9auxyhN8O6WD2jND13m+IfsdeWKSIFx3j/RJ0McJQYu4YuN8ViZm3t9
o3f5N+4DczgqzloV7U6/DFeMZ23nwBD9IgrUf6KyGoC/sJ4twTjpxSECekiOHgyn
/M7SwrBTJYJTsMXzqYBPVjk7f17+7LAwNqBNzQx6HsGV8sZX4kDlcMAL53obLV1z
kkJHhP3suaWCUl5uarZ9r5vc7DC2j6vvtghFsDvRWqqram3fCEOJOQmoAVlChbtq
SwIDAQABo3IwcDAdBgNVHQ4EFgQUEicpezwWkZY3JMEwx1D0eraiFCEwHwYDVR0j
BBgwFoAUEicpezwWkZY3JMEwx1D0eraiFCEwDwYDVR0TAQH/BAUwAwEB/zAdBgNV
HREEFjAUghJhbGNoZW15LXNzbC1hLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAMRj
u6+KYAYwX/cuJruXaX7Pa9kX4Es+637dDPWBP9lLedVOGEpOujiDn2JUuNZNl6vo
eqaJrjQuJkSgVVYikz3dGWTEvqlDIJ5nbRIo8etW1d5eoZeWcd95t2VXNRlfULBS
eNOFYOI6iaPW2CQXFvNAgER/Azj8Y4ilky504m0bqkZWTl/2f+x1KaiBqkxqiOdX
n5gPpu+jujVOyJni7KJo4+iIdWtQI1xAazXyOFefTMkPGLkXeQ/+tXrmY9NoVvNO
JBEe8o+wi/LxH/K9/It1rCfWckb5zHU57li4ZxetlwYssVW4Of25sMp9c4JNF3gJ
mkhcNRA0cRkbnom+kn8=
-----END CERTIFICATE-----`;

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
  trustStores: [{ trustAnchors: [{ pemCertificate: TRUST_ANCHOR }] }],
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
    hostname: "thp.alchemy.test",
  });
});

/** A DevOps-tier pool with an enabled self-signed root, which an issuance config issues from. */
export const ProbeIssuanceConfig = Effect.gen(function* () {
  const pool = yield* GCP.PrivateCA.CaPool("ProbeIssuancePool", {
    location: "us-central1",
    tier: "DEVOPS",
  });
  const ca = yield* GCP.PrivateCA.CertificateAuthority("ProbeIssuanceCa", {
    caPool: pool.name,
    location: "us-central1",
    type: "SELF_SIGNED",
    desiredState: "ENABLED",
    lifetime: "315360000s",
    keySpec: { algorithm: "EC_P256_SHA256" },
    config: {
      subjectConfig: {
        subject: { organization: "Alchemy", commonName: "Alchemy Probe Issuance Root" },
      },
      x509Config: {
        caOptions: { isCa: true },
        keyUsage: { baseKeyUsage: { certSign: true, crlSign: true } },
      },
    },
  });
  return yield* GCP.CertificateManager.CertificateIssuanceConfig("ProbeIssuance", {
    location: "us-central1",
    labels: { ca: ca.certificateAuthorityId },
    lifetime: "2592000s",
    rotationWindowPercentage: 66,
    keyAlgorithm: "ECDSA_P256",
    certificateAuthorityConfig: { certificateAuthorityServiceConfig: { caPool: pool.name } },
  });
});
