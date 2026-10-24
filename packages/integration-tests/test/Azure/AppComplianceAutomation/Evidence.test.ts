import * as Azure from "@alchemy.run/azure";
import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { gone, logLevel, reportProgram, tags, userToken } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEvidence = (reportName: string, evidenceName: string) =>
  Effect.flatMap(userToken, (token) =>
    acat.GetEvidence({ reportName, evidenceName, userToken: token }),
  );

const program = (props: { name?: string; filePath: string }) =>
  Effect.gen(function* () {
    const { report } = yield* reportProgram;
    const evidence = yield* Azure.AppComplianceAutomation.Evidence("Evidence", {
      reportName: report.reportName,
      name: props.name,
      filePath: props.filePath,
      controlId: "Operational_Security_10",
    });
    return { report, evidence };
  });

// Free; seconds.
test.provider(
  "reading evidence of a missing report is a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* getEvidence("alchemy-acat-probe", "probe").pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

// Skipped: the parent report cannot be created by the testing service
// principal: HTTP 502 `BearerFallbackDisabled` ("Server failed to process the
// request."), see Report.test.ts. Storage account (~$0) + report (free); ~5 min.
test.provider.skip(
  "create, update, replace, and delete app compliance evidence",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { report, evidence } = yield* stack.deploy(
        program({ filePath: "/evidence/tls-policy-v1.pdf" }),
      );
      expect(evidence.reportName).toEqual(report.reportName);
      expect(evidence.evidenceType).toEqual("File");
      const observed = yield* getEvidence(report.reportName, evidence.evidenceName);
      expect(observed.properties.filePath).toEqual("/evidence/tls-policy-v1.pdf");
      expect(observed.properties.controlId).toEqual("Operational_Security_10");

      // In place: the file path.
      const updated = yield* stack.deploy(program({ filePath: "/evidence/tls-policy-v2.pdf" }));
      expect(updated.evidence.evidenceName).toEqual(evidence.evidenceName);
      const reobserved = yield* getEvidence(report.reportName, evidence.evidenceName);
      expect(reobserved.properties.filePath).toEqual("/evidence/tls-policy-v2.pdf");

      // Replacement: the name is the evidence's identity.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-test-acat-evidence-replaced",
          filePath: "/evidence/tls-policy-v2.pdf",
        }),
      );
      expect(replaced.evidence.evidenceName).toEqual("alchemy-test-acat-evidence-replaced");
      const replacedOne = yield* gone(getEvidence(report.reportName, evidence.evidenceName));
      expect(replacedOne).toEqual("gone");

      yield* stack.destroy();
      const destroyed = yield* gone(getEvidence(report.reportName, replaced.evidence.evidenceName));
      expect(destroyed).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
