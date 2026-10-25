import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import OrderWorkflowsLive, { OrderWorkflows } from "./src/OrderWorkflows.ts";

export default Alchemy.Stack(
  "AzureEffectWorkflowsExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const workflows = yield* OrderWorkflows;
    const { taskHub } = yield* OrderWorkflows.durableTask;
    const api = yield* Api;
    return {
      url: api.url,
      workflowsApp: workflows.functionAppName,
      resourceGroup: workflows.resourceGroup,
      scheduler: taskHub.scheduler,
      taskHub: taskHub.taskHubName,
      dashboard: taskHub.dashboardUrl,
    };
  }).pipe(Effect.provide(OrderWorkflowsLive)),
);
