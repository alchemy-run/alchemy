import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { WorkflowEngine } from "effect/workflow";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { type Implemented, implemented } from "../../Workflows/Implemented.ts";
import { type Calls, type LambdaServices, makeCalls, makeEngine } from "./DurableWorkflows.ts";
import { type Function, isBindingHost } from "./Function.ts";
import type { ImplementedEach, WorkflowFunctionClass, WorkflowNames } from "./WorkflowFunction.ts";

type HostedBy<Host> = Host extends WorkflowFunctionClass<any, infer W> ? WorkflowNames<W> : never;

/**
 * Run workflows hosted by {@link WorkflowFunction | AWS.Lambda.WorkflowFunction}s
 * from another Lambda function: a `WorkflowEngine` that starts, reads,
 * signals and interrupts each workflow's runs on the function that hosts it.
 *
 * Provide it to the calling function, and resolve each workflow's client with
 * `Workflows.RunWorkflow` during init. It grants the caller the IAM it needs
 * on each host. Running a workflow none of the hosts list is a type error.
 *
 * ### Running workflows from another function
 * **Example:** An API that starts orders
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { OrderWorkflows } from "./OrderWorkflows.ts";
 * import { PlaceOrder } from "./orders.ts";
 *
 * export class Api extends AWS.Lambda.Function<Api>()("Api") {}
 *
 * export default Api.make(
 *   { main: import.meta.url, functionUrl: true },
 *   Effect.gen(function* () {
 *     const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* placeOrder.start({ orderId: "o-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.Lambda.DurableFunctionEngine(OrderWorkflows))),
 * );
 * ```
 *
 * **Example:** Workflows across several functions
 * ```typescript
 * Effect.provide(AWS.Lambda.DurableFunctionEngine(OrderWorkflows, BillingWorkflows))
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Lambda
 */
export const DurableFunctionEngine = <
  const Hosts extends ReadonlyArray<WorkflowFunctionClass<any, any>>,
>(
  ...hosts: Hosts
): Layer.Layer<
  WorkflowEngine.WorkflowEngine | ImplementedEach<HostedBy<Hosts[number]>>,
  never,
  LambdaServices | Function["Providers"]
> =>
  Layer.merge(
    Layer.effect(
      WorkflowEngine.WorkflowEngine,
      Effect.gen(function* () {
        const context = yield* Effect.context<LambdaServices>();
        const caller = yield* Binding.Host;
        const routes = new Map<string, Calls>();
        for (const host of hosts) {
          const fn = yield* host;
          if (!globalThis.__ALCHEMY_RUNTIME__ && isBindingHost(caller)) {
            yield* caller.bind`Allow(${caller}, AWS.Lambda.DurableFunctionEngine(${fn}))`({
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["lambda:InvokeFunction"],
                  Resource: [fn.functionArn, Output.interpolate`${fn.functionArn}:*`],
                },
                // Durable execution ARNs aren't function ARNs, so reading and
                // signalling runs is granted account-wide, as the host's own is.
                {
                  Effect: "Allow",
                  Action: [
                    "lambda:ListDurableExecutionsByFunction",
                    "lambda:GetDurableExecution",
                    "lambda:GetDurableExecutionHistory",
                    "lambda:StopDurableExecution",
                    "lambda:SendDurableExecutionCallbackSuccess",
                    "lambda:SendDurableExecutionCallbackFailure",
                  ],
                  Resource: ["*"],
                },
              ],
            });
          }
          const functionName = yield* fn.functionName;
          const calls = makeCalls(
            (effect) => effect.pipe(Effect.provide(context)),
            functionName,
            "$LATEST",
          );
          for (const workflow of host.workflows) routes.set(workflow._tag, calls);
        }
        return makeEngine({
          route: (workflowName) => {
            const calls = routes.get(workflowName);
            return calls
              ? Effect.succeed(calls)
              : Effect.die(new Error(`No WorkflowFunction hosts workflow ${workflowName}`));
          },
          // Workflows run on their hosts; nothing registers here.
          register: () => undefined,
        });
      }),
    ),
    implemented(
      hosts.flatMap((host) => host.workflows.map((workflow) => workflow._tag)),
    ) as Layer.Layer<ImplementedEach<HostedBy<Hosts[number]>>>,
  ) as Layer.Layer<
    WorkflowEngine.WorkflowEngine | ImplementedEach<HostedBy<Hosts[number]>>,
    never,
    LambdaServices | Function["Providers"]
  >;
