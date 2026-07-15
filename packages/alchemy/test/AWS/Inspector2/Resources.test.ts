import * as AWS from "@/AWS";
import { CisScanConfiguration } from "@/AWS/Inspector2/CisScanConfiguration.ts";
import { Filter } from "@/AWS/Inspector2/Filter.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as inspector2 from "@distilled.cloud/aws/inspector2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// One aggregate lifecycle test: the filter and the CIS scan configuration
// are both cheap account-level configuration objects, so provisioning them
// together keeps the suite fast. Neither requires Inspector scanning to be
// enabled.
test.provider(
  "lifecycle: findings filter and CIS scan configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (props: {
        filterAction: "NONE" | "SUPPRESS";
        filterReason: string;
        securityLevel: "LEVEL_1" | "LEVEL_2";
        timeOfDay: string;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const filter = yield* Filter("SuppressInfo", {
              action: props.filterAction,
              reason: props.filterReason,
              description: "created by alchemy Inspector2 resource test",
              filterCriteria: {
                severity: [{ comparison: "EQUALS", value: "INFORMATIONAL" }],
              },
              tags: { env: "test" },
            });
            const cis = yield* CisScanConfiguration("NightlyCis", {
              securityLevel: props.securityLevel,
              schedule: {
                daily: {
                  startTime: { timeOfDay: props.timeOfDay, timezone: "UTC" },
                },
              },
              targets: {
                accountIds: ["SELF"],
                targetResourceTags: { AlchemyCisTest: ["true"] },
              },
              tags: { env: "test" },
            });
            return {
              filterArn: filter.arn,
              filterName: filter.name,
              filterAction: filter.action,
              filterReason: filter.reason,
              scanConfigurationArn: cis.scanConfigurationArn,
              scanName: cis.scanName,
              securityLevel: cis.securityLevel,
            };
          }),
        );

      // Create.
      const created = yield* deploy({
        filterAction: "SUPPRESS",
        filterReason: "informational findings are tracked elsewhere",
        securityLevel: "LEVEL_1",
        timeOfDay: "02:00",
      });
      expect(created.filterArn).toContain(":filter/");
      expect(created.filterAction).toBe("SUPPRESS");
      expect(created.scanConfigurationArn).toContain("scan-configuration");
      expect(created.securityLevel).toBe("LEVEL_1");

      // Out-of-band verification via distilled.
      const liveFilter = (yield* inspector2.listFilters({
        arns: [created.filterArn],
      })).filters[0];
      expect(liveFilter?.action).toBe("SUPPRESS");
      expect(liveFilter?.tags?.["env"]).toBe("test");
      const liveCis = (yield* inspector2.listCisScanConfigurations({
        filterCriteria: {
          scanConfigurationArnFilters: [
            { comparison: "EQUALS", value: created.scanConfigurationArn },
          ],
        },
      })).scanConfigurations?.[0];
      expect(liveCis?.securityLevel).toBe("LEVEL_1");
      expect(liveCis?.schedule?.daily?.startTime.timeOfDay).toBe("02:00");

      // Canonical list() coverage.
      const filterProvider = yield* Provider.findProvider(Filter);
      const filters = yield* filterProvider.list();
      expect(filters.some((f) => f.arn === created.filterArn)).toBe(true);
      const cisProvider = yield* Provider.findProvider(CisScanConfiguration);
      const configs = yield* cisProvider.list();
      expect(
        configs.some(
          (c) => c.scanConfigurationArn === created.scanConfigurationArn,
        ),
      ).toBe(true);

      // Update in place — action/reason on the filter, level/schedule on the
      // CIS configuration. Identities (ARNs) must be stable.
      const updated = yield* deploy({
        filterAction: "NONE",
        filterReason: "keep them visible after all",
        securityLevel: "LEVEL_2",
        timeOfDay: "03:30",
      });
      expect(updated.filterArn).toBe(created.filterArn);
      expect(updated.filterAction).toBe("NONE");
      expect(updated.scanConfigurationArn).toBe(created.scanConfigurationArn);
      expect(updated.securityLevel).toBe("LEVEL_2");

      const updatedCis = (yield* inspector2.listCisScanConfigurations({
        filterCriteria: {
          scanConfigurationArnFilters: [
            { comparison: "EQUALS", value: created.scanConfigurationArn },
          ],
        },
      })).scanConfigurations?.[0];
      expect(updatedCis?.securityLevel).toBe("LEVEL_2");
      expect(updatedCis?.schedule?.daily?.startTime.timeOfDay).toBe("03:30");

      // Destroy — both are gone.
      yield* stack.destroy();
      const goneFilter = yield* inspector2.listFilters({
        arns: [created.filterArn],
      });
      expect(goneFilter.filters).toHaveLength(0);
      const goneCis = yield* inspector2.listCisScanConfigurations({
        filterCriteria: {
          scanConfigurationArnFilters: [
            { comparison: "EQUALS", value: created.scanConfigurationArn },
          ],
        },
      });
      expect(goneCis.scanConfigurations ?? []).toHaveLength(0);
    }),
  { timeout: 180_000 },
);
