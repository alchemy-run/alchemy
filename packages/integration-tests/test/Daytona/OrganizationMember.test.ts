import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

// Changing a real member's access needs a second user in the test
// organization; this asserts the typed failure for someone who isn't a member.
test.provider(
  "managing access for someone outside the organization fails with MemberNotInOrganization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(
          Daytona.OrganizationMember("Nobody", {
            user: `not-a-member-${stack.stage}@example.com`,
            role: "member",
          }),
        )
        .pipe(Effect.flip);
      expect(String(error)).toContain("is not a member of the Daytona organization");
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 60_000 },
);
