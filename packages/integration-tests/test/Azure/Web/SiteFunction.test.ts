import * as Azure from "@alchemy.run/azure";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { flexConnectionString, flexStorage } from "./fixtures/flex-app.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const FUNCTION_NAME = "Hello";

const getFunction = (resourceGroupName: string, name: string, slot?: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const where = { subscriptionId, resourceGroupName, name, functionName: FUNCTION_NAME };
    return slot === undefined
      ? yield* web.GetWebAppFunction(where)
      : yield* web.GetWebAppInstanceFunctionSlot({ ...where, slot });
  });

const functionGone = (resourceGroupName: string, name: string, slot?: string) =>
  getFunction(resourceGroupName, name, slot).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const httpConfig = (methods: string[]) => ({
  bindings: [
    {
      authLevel: "function",
      type: "httpTrigger",
      direction: "in",
      name: "Request",
      methods,
    },
    { type: "http", direction: "out", name: "Response" },
  ],
});

const script = (body: string) =>
  `Push-OutputBinding -Name Response -Value ([HttpResponseContext]@{ StatusCode = 200; Body = "${body}" })`;

const program = (
  connection: string,
  fn: { body: string; methods: string[]; slot: boolean } | undefined,
) =>
  Effect.gen(function* () {
    const { group } = yield* flexStorage;
    // eastus has zero App Service quota; westus2 accepts S1 plans. A
    // dedicated Windows plan keeps the app's file system writable.
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "S1",
      os: "windows",
    });
    const settings = {
      AzureWebJobsStorage: connection,
      FUNCTIONS_WORKER_RUNTIME: "powershell",
      FUNCTIONS_EXTENSION_VERSION: "~4",
    };
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
      appSettings: settings,
    });
    const hello =
      fn === undefined
        ? undefined
        : yield* Azure.Web.SiteFunction("Hello", {
            resourceGroup: group.resourceGroupName,
            functionAppName: app.siteName,
            slot: fn.slot ? slot.slotName : undefined,
            name: FUNCTION_NAME,
            config: httpConfig(fn.methods),
            files: { "run.ps1": script(fn.body) },
          });
    return { group, app, hello };
  });

// S1 Windows plan: ~$0.10/h, about $0.03 per run (Standard_LRS storage).
// Provisioning: ~4-6 minutes.
// Skipped: create works, but DeleteWebAppFunction answers HTTP 404
// `NotFound` "Error deleting function." while GetWebAppFunction keeps
// returning the function (observed 2026-10-23 on an S1 Windows PowerShell
// app in westus2), so the delete never converges.
test.provider.skip(
  "define, update, move to a slot, and delete a function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(flexStorage);
      const connection = yield* flexConnectionString(
        group.resourceGroupName,
        account.storageAccountName,
      );

      const { app, hello } = yield* stack.deploy(
        program(connection, { body: "v1", methods: ["get"], slot: false }),
      );
      expect(hello?.functionName).toEqual(FUNCTION_NAME);
      expect(hello?.isDisabled).toEqual(false);
      const observed = yield* getFunction(group.resourceGroupName, app.siteName);
      expect(JSON.stringify(observed.properties?.config)).toContain('"methods":["get"]');

      // In-place update: new script, and the trigger accepts POST too.
      const updated = yield* stack.deploy(
        program(connection, { body: "v2", methods: ["get", "post"], slot: false }),
      );
      expect(updated.hello?.functionId).toEqual(hello?.functionId);
      const reobserved = yield* getFunction(group.resourceGroupName, app.siteName);
      expect(JSON.stringify(reobserved.properties?.config)).toContain('"methods":["get","post"]');

      // Replacement: move the function to the staging slot.
      const moved = yield* stack.deploy(
        program(connection, { body: "v2", methods: ["get", "post"], slot: true }),
      );
      expect(moved.hello?.slot).toEqual("staging");
      const inSlot = yield* getFunction(group.resourceGroupName, app.siteName, "staging");
      expect(JSON.stringify(inSlot.properties?.config)).toContain("httpTrigger");
      expect(yield* functionGone(group.resourceGroupName, app.siteName)).toEqual("gone");

      // Delete only the function.
      yield* stack.deploy(program(connection, undefined));
      expect(yield* functionGone(group.resourceGroupName, app.siteName, "staging")).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);
