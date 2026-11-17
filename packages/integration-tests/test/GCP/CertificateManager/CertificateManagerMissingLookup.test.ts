import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:certificatemanager", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-certificate": GCP.CertificateManager.Certificate.lookup({ certificateId: name })
          .name,
        "missing-certificate-issuance-config":
          GCP.CertificateManager.CertificateIssuanceConfig.lookup({
            certificateIssuanceConfigId: name,
          }).name,
        "missing-certificate-map": GCP.CertificateManager.CertificateMap.lookup({
          certificateMapId: name,
        }).name,
        "missing-certificate-map-entry": GCP.CertificateManager.CertificateMapEntry.lookup({
          certificateMapEntryId: name,
          certificateMap: name,
        }).name,
        "missing-dns-authorization": GCP.CertificateManager.DnsAuthorization.lookup({
          dnsAuthorizationId: name,
        }).name,
        "missing-trust-config": GCP.CertificateManager.TrustConfig.lookup({ trustConfigId: name })
          .name,
      });
    }),
  { tags, timeout: 150000 },
);
