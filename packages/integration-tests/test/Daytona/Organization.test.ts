import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

const gone = (organizationId: string) =>
  organizations.getOrganization({ organizationId }).pipe(
    Effect.as(false),
    Effect.catchTag("OrganizationNotFound", () => Effect.succeed(true)),
  );

test.provider(
  "create an organization, replace it when its default region changes, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const created = yield* stack.deploy(Daytona.Organization("Team", { defaultRegionId: "us" }));
      expect(created.defaultRegionId).toEqual("us");

      const unchanged = yield* stack.plan(Daytona.Organization("Team", { defaultRegionId: "us" }));
      expect(unchanged.resources.Team?.action).toEqual("noop");

      // Daytona sets the default region once.
      const replaced = yield* stack.deploy(Daytona.Organization("Team", { defaultRegionId: "eu" }));
      expect(replaced.organizationId).not.toEqual(created.organizationId);
      expect(replaced.defaultRegionId).toEqual("eu");
      expect(yield* gone(created.organizationId)).toBe(true);

      yield* stack.destroy();
      expect(yield* gone(replaced.organizationId)).toBe(true);
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);
