import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iotfleetwise from "@distilled.cloud/aws/iotfleetwise";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// AWS IoT FleetWise is offered in us-east-1/eu-central-1 only — pin every
// out-of-band distilled call to the service's home region (the providers
// pin themselves the same way).
const inHomeRegion = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.provideService(Region, Effect.succeed("us-east-1")));

// Ungated typed-error probe: prove the distilled error union carries the
// typed tags the providers' read/delete paths depend on. AWS IoT FleetWise
// is allowlist-gated — accounts without service access observe
// AccessDeniedException (with an empty message) on every operation, while
// allowlisted accounts observe ResourceNotFoundException for a bogus name.
// Both are typed tags in the operation's error union; the probe proves the
// decode path for whichever gate this account is behind.
test.provider(
  "getSignalCatalog on a nonexistent catalog fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotfleetwise
          .getSignalCatalog({ name: "alchemy-nonexistent-catalog-probe" })
          .pipe(inHomeRegion),
      );
      expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(error._tag);
    }),
  { tags: ["provider:aws", "provider:aws:iotfleetwise", "live"] },
);

// Same ungated probe for the state-template API — proves the typed tags the
// StateTemplate provider's read path depends on decode on every account.
test.provider(
  "getStateTemplate on a nonexistent template fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        iotfleetwise
          .getStateTemplate({ identifier: "alchemy-nonexistent-state-template-probe" })
          .pipe(inHomeRegion),
      );
      expect(["ResourceNotFoundException", "AccessDeniedException"]).toContain(error._tag);
    }),
  { tags: ["provider:aws", "provider:aws:iotfleetwise", "live"] },
);
