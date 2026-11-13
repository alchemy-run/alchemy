import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

const preview = (previewId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    const result = yield* organization.listOrganizationPublicPreviews({ organizationId });
    return (result ?? []).find((p) => p.id === previewId);
  });

test.provider(
  "switch a preview on, keep it on unchanged, restore it on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const before = yield* preview("health-checks");
      expect(before?.canToggle).toBe(true);

      const on = yield* stack.deploy(
        ClickHouseCloud.Organization.PreviewFeature("HealthChecks", { previewId: "health-checks" }),
      );
      expect(on.enabled).toBe(true);
      expect(on.originalEnabled).toEqual(before?.enabled);
      expect((yield* preview("health-checks"))?.enabled).toBe(true);

      yield* stack.destroy();
      expect((yield* preview("health-checks"))?.enabled).toEqual(before?.enabled);
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider(
  "a preview the organization isn't offered fails with PreviewNotOffered",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack
        .deploy(
          ClickHouseCloud.Organization.PreviewFeature("Missing", {
            previewId: "alchemy-no-such-preview",
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ClickHouseCloud.PreviewNotOffered");
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
