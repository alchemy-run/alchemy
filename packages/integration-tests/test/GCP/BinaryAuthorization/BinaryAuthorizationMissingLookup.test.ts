import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:binaryauthorization", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-attestor": GCP.BinaryAuthorization.Attestor.lookup({ attestorId: name }).name,
        "missing-platforms-policy": GCP.BinaryAuthorization.PlatformsPolicy.lookup({
          policyId: name,
        }).name,
      });
    }),
  { tags, timeout: 90000 },
);
