import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "probe inspector2 account state",
  (_stack) =>
    Effect.gen(function* () {
      const status = yield* Effect.result(inspector2.batchGetAccountStatus({}));
      console.log(
        "batchGetAccountStatus:",
        Result.isSuccess(status)
          ? JSON.stringify(status.success.accounts?.[0], null, 2)
          : String(status.failure),
      );

      const filters = yield* Effect.result(inspector2.listFilters({}));
      console.log(
        "listFilters:",
        Result.isSuccess(filters)
          ? JSON.stringify(filters.success.filters?.length)
          : `FAIL ${(filters.failure as { _tag?: string })._tag}: ${String(filters.failure)}`,
      );

      const createFilter = yield* Effect.result(
        inspector2.createFilter({
          name: "alchemy-probe-filter",
          action: "SUPPRESS",
          filterCriteria: {
            severity: [{ comparison: "EQUALS", value: "INFORMATIONAL" }],
          },
        }),
      );
      console.log(
        "createFilter:",
        Result.isSuccess(createFilter)
          ? createFilter.success.arn
          : `FAIL ${(createFilter.failure as { _tag?: string })._tag}: ${String(createFilter.failure)}`,
      );
      if (Result.isSuccess(createFilter)) {
        yield* inspector2.deleteFilter({ arn: createFilter.success.arn });
        console.log("deleteFilter: ok");
      }

      const cis = yield* Effect.result(
        inspector2.listCisScanConfigurations({}),
      );
      console.log(
        "listCisScanConfigurations:",
        Result.isSuccess(cis)
          ? JSON.stringify(cis.success.scanConfigurations?.length)
          : `FAIL ${(cis.failure as { _tag?: string })._tag}: ${String(cis.failure)}`,
      );

      const cisCreate = yield* Effect.result(
        inspector2.createCisScanConfiguration({
          scanName: "alchemy-probe-cis",
          securityLevel: "LEVEL_1",
          schedule: { oneTime: {} },
          targets: {
            accountIds: ["SELF"],
            targetResourceTags: { probe: ["alchemy"] },
          },
        }),
      );
      console.log(
        "createCisScanConfiguration:",
        Result.isSuccess(cisCreate)
          ? cisCreate.success.scanConfigurationArn
          : `FAIL ${(cisCreate.failure as { _tag?: string })._tag}: ${String(cisCreate.failure)}`,
      );
      if (
        Result.isSuccess(cisCreate) &&
        cisCreate.success.scanConfigurationArn
      ) {
        yield* inspector2.deleteCisScanConfiguration({
          scanConfigurationArn: cisCreate.success.scanConfigurationArn,
        });
        console.log("deleteCisScanConfiguration: ok");
      }

      const search = yield* Effect.result(
        inspector2.searchVulnerabilities({
          filterCriteria: { vulnerabilityIds: ["CVE-2021-44228"] },
        }),
      );
      console.log(
        "searchVulnerabilities:",
        Result.isSuccess(search)
          ? `ok ${search.success.vulnerabilities?.length}`
          : `FAIL ${(search.failure as { _tag?: string })._tag}: ${String(search.failure)}`,
      );

      const usage = yield* Effect.result(inspector2.listUsageTotals({}));
      console.log(
        "listUsageTotals:",
        Result.isSuccess(usage)
          ? `ok ${usage.success.totals?.length}`
          : `FAIL ${(usage.failure as { _tag?: string })._tag}: ${String(usage.failure)}`,
      );

      const perms = yield* Effect.result(inspector2.listAccountPermissions({}));
      console.log(
        "listAccountPermissions:",
        Result.isSuccess(perms)
          ? `ok ${perms.success.permissions?.length}`
          : `FAIL ${(perms.failure as { _tag?: string })._tag}: ${String(perms.failure)}`,
      );

      const cfg = yield* Effect.result(inspector2.getConfiguration({}));
      console.log(
        "getConfiguration:",
        Result.isSuccess(cfg)
          ? JSON.stringify(cfg.success)
          : `FAIL ${(cfg.failure as { _tag?: string })._tag}: ${String(cfg.failure)}`,
      );
    }),
  { timeout: 120_000 },
);
