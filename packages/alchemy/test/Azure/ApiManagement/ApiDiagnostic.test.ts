import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  consumptionApi,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApiDiagnostic = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiDiagnostic({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      diagnosticId: "applicationinsights",
    }),
  );

const program = (percentage?: number) =>
  Effect.gen(function* () {
    const { group, service, api } = yield* consumptionApi;
    // APIM stores Application Insights keys without validating them.
    const logger = yield* Azure.ApiManagement.Logger("Insights", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-api-diag",
      loggerType: "applicationInsights",
      credentials: {
        instrumentationKey: Redacted.make(
          "00000000-0000-4000-8000-000000000021",
        ),
      },
    });
    const diagnostic =
      percentage === undefined
        ? undefined
        : yield* Azure.ApiManagement.ApiDiagnostic("ApiInsights", {
            resourceGroup: group.resourceGroupName,
            serviceName: service.serviceName,
            apiName: api.apiName,
            loggerId: logger.loggerId,
            alwaysLog: "allErrors",
            sampling: { samplingType: "fixed", percentage },
            verbosity: "information",
          });
    return { group, service, api, diagnostic };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, and delete an API diagnostic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program(50));
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const api = first.api.apiName;
      expect(first.diagnostic?.diagnosticName).toEqual("applicationinsights");
      expect(first.diagnostic?.apiName).toEqual(api);
      const observed = yield* getApiDiagnostic(rg, svc, api);
      expect(observed.properties?.sampling?.percentage).toEqual(50);
      expect(observed.properties?.loggerId).toContain("alchemy-api-diag");

      // In-place update of the sampling percentage.
      yield* stack.deploy(program(25));
      expect(
        (yield* getApiDiagnostic(rg, svc, api)).properties?.sampling
          ?.percentage,
      ).toEqual(25);

      // Removing the resource deletes the API diagnostic.
      yield* stack.deploy(program());
      expect(yield* untilGone(getApiDiagnostic(rg, svc, api))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
