import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { flexStorage } from "./flex-app.ts";

/** Name of the function `slotFunction` defines. */
export const SLOT_FUNCTION_NAME = "Hello";

/**
 * A PowerShell function app on a Standard (S1) Windows plan in westus2 with
 * a `staging` slot, for slot-scoped function children (keys). Storage comes
 * from `flexStorage`; pass its connection string (see
 * `flexConnectionString`).
 */
export const windowsFunctionApp = (connection: string) =>
  Effect.gen(function* () {
    const { group } = yield* flexStorage;
    // eastus has zero App Service quota; westus2 accepts S1 plans.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "S1",
      os: "windows",
    });
    const app = yield* Azure.Web.FunctionApp("Api", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "windows",
      runtime: { name: "powershell" },
      siteConfig: { powerShellVersion: "7.4", alwaysOn: false },
      appSettings: { AzureWebJobsStorage: connection },
    });
    const slot = yield* Azure.Web.WebAppSlot("Slot", {
      resourceGroup: group.resourceGroupName,
      siteName: app.siteName,
      name: "staging",
      siteConfig: { powerShellVersion: "7.4", alwaysOn: false },
      appSettings: {
        AzureWebJobsStorage: connection,
        FUNCTIONS_WORKER_RUNTIME: "powershell",
        FUNCTIONS_EXTENSION_VERSION: "~4",
      },
    });
    return { group, app, slot };
  });

/**
 * One HTTP-triggered function in the slot of `windowsFunctionApp`, defined
 * in place through ARM (`Azure.Web.SiteFunction`).
 */
export const slotFunction = (props: {
  resourceGroup: string;
  functionAppName: string;
  slot: string;
}) =>
  Azure.Web.SiteFunction("Hello", {
    resourceGroup: props.resourceGroup,
    functionAppName: props.functionAppName,
    slot: props.slot,
    name: SLOT_FUNCTION_NAME,
    config: {
      bindings: [
        {
          authLevel: "function",
          type: "httpTrigger",
          direction: "in",
          name: "Request",
          methods: ["get"],
        },
        { type: "http", direction: "out", name: "Response" },
      ],
    },
    files: {
      "run.ps1": `Push-OutputBinding -Name Response -Value ([HttpResponseContext]@{ StatusCode = 200; Body = "ok" })`,
    },
  });
