import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDiagnostic = (resourceGroupName: string, serviceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetDiagnostic({
      subscriptionId,
      resourceGroupName,
      serviceName,
      diagnosticId: "applicationinsights",
    }),
  );

const program = (diagnostic?: {
  logger: "one" | "two";
  percentage: number;
  verbosity: Azure.ApiManagement.DiagnosticVerbosity;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    // APIM stores Application Insights keys without validating them, so
    // placeholder keys keep the test free of an Insights component. Both
    // loggers stay deployed while the diagnostic switches between them.
    const one = yield* Azure.ApiManagement.Logger("InsightsOne", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-diag-one",
      loggerType: "applicationInsights",
      credentials: {
        instrumentationKey: Redacted.make(
          "00000000-0000-4000-8000-000000000011",
        ),
      },
    });
    const two = yield* Azure.ApiManagement.Logger("InsightsTwo", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-diag-two",
      loggerType: "applicationInsights",
      credentials: {
        instrumentationKey: Redacted.make(
          "00000000-0000-4000-8000-000000000012",
        ),
      },
    });
    const created = diagnostic
      ? yield* Azure.ApiManagement.Diagnostic("Insights", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          loggerId: diagnostic.logger === "one" ? one.loggerId : two.loggerId,
          alwaysLog: "allErrors",
          sampling: {
            samplingType: "fixed",
            percentage: diagnostic.percentage,
          },
          verbosity: diagnostic.verbosity,
          logClientIp: true,
        })
      : undefined;
    return { group, service, diagnostic: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, and delete a service diagnostic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ logger: "one", percentage: 50, verbosity: "information" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.diagnostic?.diagnosticName).toEqual("applicationinsights");
      const observed = yield* getDiagnostic(rg, svc);
      expect(observed.properties?.loggerId).toContain(
        "/loggers/alchemy-diag-one",
      );
      expect(observed.properties?.sampling?.percentage).toEqual(50);
      expect(observed.properties?.verbosity).toEqual("information");
      expect(observed.properties?.alwaysLog).toEqual("allErrors");

      // In-place update: sampling, verbosity, and the target logger.
      yield* stack.deploy(
        program({ logger: "two", percentage: 25, verbosity: "error" }),
      );
      const updated = yield* getDiagnostic(rg, svc);
      expect(updated.properties?.loggerId).toContain(
        "/loggers/alchemy-diag-two",
      );
      expect(updated.properties?.sampling?.percentage).toEqual(25);
      expect(updated.properties?.verbosity).toEqual("error");

      // Removing the resource deletes the diagnostic.
      yield* stack.deploy(program());
      expect(yield* untilGone(getDiagnostic(rg, svc))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
