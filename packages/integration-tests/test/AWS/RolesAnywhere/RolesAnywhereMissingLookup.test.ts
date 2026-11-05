import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:rolesanywhere", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (crl, profile, trust anchor).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-crl": AWS.RolesAnywhere.Crl.lookup({
          crlId: "11111111-1111-4111-8111-111111111111",
        }).crlId,
        "missing-profile": AWS.RolesAnywhere.Profile.lookup({
          profileId: "11111111-1111-4111-8111-111111111111",
        }).profileId,
        "missing-trust-anchor": AWS.RolesAnywhere.TrustAnchor.lookup({
          trustAnchorId: "11111111-1111-4111-8111-111111111111",
        }).trustAnchorId,
      });
    }),
  { tags, timeout: 180_000 },
);
