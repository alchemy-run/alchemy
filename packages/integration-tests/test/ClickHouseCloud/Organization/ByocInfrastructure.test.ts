import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";
import { messageOf } from "../fixtures/errors.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// BYOC needs ClickHouse to enable it for the organization and a cloud
// account onboarded for it (the account ID and region below). Set
// CLICKHOUSE_CLOUD_TEST_BYOC_ACCOUNT_ID to run the lifecycle test; it
// provisions real infrastructure in that account.
const byocAccountId = process.env.CLICKHOUSE_CLOUD_TEST_BYOC_ACCOUNT_ID;

const declare = (accountId: string, displayName: string) =>
  ClickHouseCloud.Organization.ByocInfrastructure("Byoc", {
    regionId: "us-east-1",
    accountId,
    displayName,
  });

test.provider.skipIf(byocAccountId !== undefined)(
  "outside a BYOC organization the deploy fails with FeatureUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack.deploy(declare("000000000000", "alchemy test")).pipe(Effect.flip);
      expect(error._tag).toEqual("FeatureUnavailable");
      expect(messageOf(error)).toEqual("FORBIDDEN: Not a byoc organization");
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(byocAccountId === undefined)(
  "provision BYOC infrastructure, rename it in place, tear it down",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      if (byocAccountId === undefined) return;
      const created = yield* stack.deploy(declare(byocAccountId, "alchemy test"));
      expect(created.accountId).toEqual(byocAccountId);
      const renamed = yield* stack.deploy(declare(byocAccountId, "alchemy test renamed"));
      expect(renamed.byocInfrastructureId).toEqual(created.byocInfrastructureId);
      expect(renamed.displayName).toEqual("alchemy test renamed");
      yield* stack.destroy();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 7_200_000 },
);
