import * as Azure from "@alchemy.run/azure";
import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getReport, gone, logLevel, reportProgram, tags, userToken } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (reportName: string) =>
  Effect.flatMap(userToken, (token) =>
    acat.GetScopingConfiguration({
      reportName,
      scopingConfigurationName: "default",
      userToken: token,
    }),
  );

const program = (props: { secondReport: boolean; answer: string }) =>
  Effect.gen(function* () {
    const { account, report } = yield* reportProgram;
    const other = props.secondReport
      ? yield* Azure.AppComplianceAutomation.Report("Other", {
          resources: [{ resourceId: account.storageAccountId }],
        })
      : undefined;
    const scoping = yield* Azure.AppComplianceAutomation.ScopingConfiguration("Scoping", {
      reportName: (other ?? report).reportName,
      answers: [{ questionId: "GDPR_global", answers: [props.answer] }],
    });
    return { report, other, scoping };
  });

// Free; seconds.
test.provider(
  "reading the scoping configuration of a missing report is a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* getConfiguration("alchemy-acat-probe").pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

// Skipped: the parent report cannot be created by the testing service
// principal: HTTP 502 `BearerFallbackDisabled` ("Server failed to process the
// request."), see Report.test.ts. Storage account (~$0) + reports (free); ~5 min.
test.provider.skip(
  "create, update, replace, and delete a report scoping configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { report, scoping } = yield* stack.deploy(
        program({ secondReport: false, answer: "Yes" }),
      );
      expect(scoping.reportName).toEqual(report.reportName);
      expect(scoping.scopingConfigurationId).toEqual(
        `/providers/Microsoft.AppComplianceAutomation/reports/${report.reportName}/scopingConfigurations/default`,
      );
      const observed = yield* getConfiguration(report.reportName);
      expect(observed.properties.answers).toEqual([
        { questionId: "GDPR_global", answers: ["Yes"] },
      ]);

      // In place: the answers.
      yield* stack.deploy(program({ secondReport: false, answer: "No" }));
      const reobserved = yield* getConfiguration(report.reportName);
      expect(reobserved.properties.answers).toEqual([
        { questionId: "GDPR_global", answers: ["No"] },
      ]);

      // Replacement: moving to another report deletes the old configuration.
      const moved = yield* stack.deploy(program({ secondReport: true, answer: "No" }));
      expect(moved.scoping.reportName).toEqual(moved.other?.reportName);
      const original = yield* getConfiguration(report.reportName).pipe(
        Effect.map((c) => c.properties.answers ?? []),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (answers) => answers.length === 0,
          times: 12,
        }),
      );
      expect(original).toEqual([]);

      yield* stack.destroy();
      const destroyed = yield* gone(getReport(report.reportName));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
