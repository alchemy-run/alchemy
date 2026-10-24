import * as Azure from "@alchemy.run/azure";
import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { getReport, gone, logLevel, tags, userToken } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { name?: string; timeZone: string; secondAccount: boolean }) =>
  Effect.gen(function* () {
    const account = yield* Azure.Storage.StorageAccount("Evidence");
    const second = yield* Azure.Storage.StorageAccount("Second");
    const report = yield* Azure.AppComplianceAutomation.Report("Report", {
      name: props.name,
      timeZone: props.timeZone,
      triggerTime: "2024-01-01T09:00:00Z",
      resources: [
        {
          resourceId: account.storageAccountId,
          resourceType: "Microsoft.Storage/storageAccounts",
        },
        ...(props.secondAccount
          ? [
              {
                resourceId: second.storageAccountId,
                resourceType: "Microsoft.Storage/storageAccounts",
              },
            ]
          : []),
      ],
    });
    return { account, second, report };
  });

// Free: reports, onboarding and name checks cost nothing; seconds.
test.provider(
  "the service principal can read reports but not write them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const token = yield* userToken;

      // The `x-ms-aad-user-token` header (distilled patch) is what lets
      // reads through: without it every call is refused.
      const refused = yield* acat.ListReport({}).pipe(Effect.flip);
      expect(refused._tag).toEqual("AppComplianceAutomationBearerFallbackDisabled");
      const missing = yield* acat
        .GetReport({ reportName: "alchemy-acat-probe", userToken: token })
        .pipe(Effect.flip);
      expect(missing._tag).toEqual("NotFound");

      // Writes need a signed-in user's token: an app-only token is refused.
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const rejected = yield* acat
        .ProviderActionsOnboard({ subscriptionIds: [subscriptionId], userToken: token })
        .pipe(Effect.flip);
      expect(rejected._tag).toEqual("AppComplianceAutomationBearerFallbackDisabled");

      // The provider surfaces the same typed refusal, and nothing is created.
      const failed = yield* stack
        .deploy(
          Azure.AppComplianceAutomation.Report("Probe", {
            name: "alchemy-acat-probe",
            resources: [
              {
                resourceId: `/subscriptions/${subscriptionId}/resourceGroups/alchemy-acat-probe/providers/Microsoft.Storage/storageAccounts/alchemyacatprobe`,
                resourceType: "Microsoft.Storage/storageAccounts",
              },
            ],
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(failed)).toContain("AppComplianceAutomationBearerFallbackDisabled");
      const absent = yield* acat
        .GetReport({ reportName: "alchemy-acat-probe", userToken: token })
        .pipe(Effect.flip);
      expect(absent._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

// Skipped: every write from the testing service principal fails with HTTP 502
// `BearerFallbackDisabled` ("Server failed to process the request."), even
// with its token in `x-ms-aad-user-token`; the lifecycle needs a signed-in
// user's token. Two storage accounts (~$0) + report (free); ~5 min.
test.provider.skip(
  "create, update, replace, and delete an app compliance report",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { account, second, report } = yield* stack.deploy(
        program({ timeZone: "UTC", secondAccount: false }),
      );
      expect(report.reportName).toMatch(/^[-a-zA-Z0-9_]{1,50}$/);
      expect(report.reportId).toEqual(
        `/providers/Microsoft.AppComplianceAutomation/reports/${report.reportName}`,
      );
      const observed = yield* getReport(report.reportName);
      expect(observed.properties.timeZone).toEqual("UTC");
      expect(observed.properties.resources.map((r) => r.resourceId.toLowerCase())).toEqual([
        account.storageAccountId.toLowerCase(),
      ]);

      // In place: time zone and the assessed resources.
      const updated = yield* stack.deploy(
        program({ timeZone: "Pacific Standard Time", secondAccount: true }),
      );
      expect(updated.report.reportName).toEqual(report.reportName);
      const reobserved = yield* getReport(report.reportName);
      expect(reobserved.properties.timeZone).toEqual("Pacific Standard Time");
      expect(reobserved.properties.resources.map((r) => r.resourceId.toLowerCase()).sort()).toEqual(
        [account.storageAccountId.toLowerCase(), second.storageAccountId.toLowerCase()].sort(),
      );

      // Replacement: the name is the report's identity.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-acat-report-replaced",
          timeZone: "Pacific Standard Time",
          secondAccount: true,
        }),
      );
      expect(replaced.report.reportName).toEqual("alchemy-test-acat-report-replaced");
      const renamed = yield* getReport(replaced.report.reportName);
      expect(renamed.properties.timeZone).toEqual("Pacific Standard Time");
      const replacedOne = yield* gone(getReport(report.reportName));
      expect(replacedOne).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getReport(replaced.report.reportName));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
