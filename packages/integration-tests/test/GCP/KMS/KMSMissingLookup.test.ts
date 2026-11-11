import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:kms", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-crypto-key": GCP.KMS.CryptoKey.lookup({ cryptoKeyId: name, keyRing: name }).name,
        "missing-crypto-key-version": GCP.KMS.CryptoKeyVersion.lookup({
          cryptoKey: name,
          cryptoKeyVersionId: name,
        }).name,
        "missing-import-job": GCP.KMS.ImportJob.lookup({ importJobId: name, keyRing: name }).name,
        "missing-key-ring": GCP.KMS.KeyRing.lookup({ keyRingId: name }).name,
        "missing-single-tenant-hsm-instance-proposal":
          GCP.KMS.SingleTenantHsmInstanceProposal.lookup({
            proposalId: name,
            singleTenantHsmInstance: name,
          }).name,
      });
    }),
  { tags, timeout: 135000 },
);
