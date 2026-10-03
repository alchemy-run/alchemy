import * as Azure from "@/Azure";
import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";

/**
 * The free trial has F1 quota only in westus3 and centralus, and Microsoft.Web
 * throttles F1 plan creates there for hours at a time once a burst of test
 * runs has created plans: HTTP 429 "App Service Plan Create operation is
 * throttled for subscription <id>. Please contact support if issue
 * persists." (`AppServicePlanCreateThrottled`). Lifecycles that need a fresh
 * F1 plan and were blocked by it run only with AZURE_TEST_PAID=1 and keep
 * this probe ungated; once the probe fails, the throttle has lifted and the
 * gate can be removed.
 */
export const f1PlanCreateRejection = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web
      .AppServicePlansCreateOrUpdate({
        subscriptionId,
        resourceGroupName,
        name: "alchemy-f1-probe",
        location: "westus3",
        kind: "linux",
        sku: { name: "F1", tier: "Free" },
        properties: { reserved: true },
      })
      .pipe(Effect.flip);
  });
