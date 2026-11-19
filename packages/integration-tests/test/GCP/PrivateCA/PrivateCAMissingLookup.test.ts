import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:privateca", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-ca-pool": GCP.PrivateCA.CaPool.lookup({ caPoolId: name }).name,
        "missing-certificate-authority": GCP.PrivateCA.CertificateAuthority.lookup({
          certificateAuthorityId: name,
          caPool: name,
        }).name,
        "missing-certificate-template": GCP.PrivateCA.CertificateTemplate.lookup({
          certificateTemplateId: name,
        }).name,
      });
    }),
  { tags, timeout: 105000 },
);
