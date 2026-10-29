import * as GCP from "@alchemy.run/gcp";
/** Resources the generated PrivateCA bindings bind: the suite's own fixtures. */
export { Pool, Root } from "./bindings-host.ts";

export const ProbeCertificateTemplate = GCP.PrivateCA.CertificateTemplate(
  "ProbeCertificateTemplate",
  {
    location: "us-central1",
    description: "leaf tls a",
    maximumLifetime: "86400s",
    identityConstraints: {
      allowSubjectPassthrough: true,
      allowSubjectAltNamesPassthrough: true,
    },
    passthroughExtensions: {
      knownExtensions: ["EXTENDED_KEY_USAGE"],
    },
    predefinedValues: {
      caOptions: { isCa: false },
      keyUsage: {
        baseKeyUsage: {
          digitalSignature: true,
          keyEncipherment: true,
        },
        extendedKeyUsage: { serverAuth: true },
      },
    },
  },
);
