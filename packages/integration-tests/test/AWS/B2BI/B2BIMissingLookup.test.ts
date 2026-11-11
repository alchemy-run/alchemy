import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:b2bi", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (capability, partnership, profile, transformer).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-capability": AWS.B2BI.Capability.lookup({ capabilityId: name }).capabilityId,
        "missing-partnership": AWS.B2BI.Partnership.lookup({ partnershipId: name }).partnershipId,
        "missing-profile": AWS.B2BI.Profile.lookup({ profileId: name }).profileId,
        "missing-transformer": AWS.B2BI.Transformer.lookup({ transformerId: name }).transformerId,
      });
    }),
  { tags, timeout: 180_000 },
);
