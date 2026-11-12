import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const observe = Effect.gen(function* () {
  const organizationId = yield* ClickHouseCloud.organizationId;
  const { result } = yield* organization.getOrganization({ organizationId });
  return result!;
});

test.provider(
  "rename the organization and restore the original name on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* observe;
      const stage = yield* Stage;
      const renamed = `alchemy ${stage}`.replace(/[^A-Za-z0-9 ]/g, " ").slice(0, 50);

      const org = yield* stack.deploy(
        ClickHouseCloud.Organization.Organization("Org", { name: renamed }),
      );
      expect(org.name).toEqual(renamed);
      expect(org.original.name).toEqual(before.name);
      expect((yield* observe).name).toEqual(renamed);

      // Undeclared settings are left alone.
      expect((yield* observe).enableCoreDumps).toEqual(before.enableCoreDumps);

      // Redeploying with the same props changes nothing and keeps the
      // captured original.
      const again = yield* stack.deploy(
        ClickHouseCloud.Organization.Organization("Org", { name: renamed }),
      );
      expect(again.original.name).toEqual(before.name);

      yield* stack.destroy();
      expect((yield* observe).name).toEqual(before.name);
    }),
  {
    tags: ["provider:clickhouse-cloud", "live"],
    exclusive: "clickhouse-cloud:organization",
    timeout: 120_000,
  },
);
