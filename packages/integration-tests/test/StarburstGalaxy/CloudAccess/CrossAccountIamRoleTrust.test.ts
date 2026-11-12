import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

test.provider(
  "the trust facts resolve through a lookup in a stack",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const trust = yield* stack.deploy(
        Effect.succeed(StarburstGalaxy.CrossAccountIamRoleTrust.lookup({})),
      );
      const live = yield* galaxy.crossAccountIamRole.getCrossAccountIamRoleMetadata({});
      expect(trust.externalId).toBe(live.externalId);
      expect(trust.starburstAwsAccountId).toMatch(/^\d{12}$/);
      expect(trust.starburstAwsAccountId).toBe(live.starburstAwsAccountId);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:cross-account-iam-role", "live"],
    timeout: 60_000,
  },
);
