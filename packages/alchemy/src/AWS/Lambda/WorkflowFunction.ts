import type { ConfigError } from "effect/Config";
import type * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import type * as Layer from "effect/Layer";
import type { Workflow, WorkflowEngine } from "effect/workflow";
import type { InputProps } from "../../Input.ts";
import type { Implemented } from "../../Workflows/Implemented.ts";
import {
  DurableFunction,
  type DurableFunctionInitServices,
  type DurableFunctionProps,
} from "./DurableFunction.ts";
import { makeWorkflowRunner } from "./DurableWorkflows.ts";
import { Function } from "./Function.ts";

/** @internal */
export type WorkflowNames<W> =
  W extends Workflow.Workflow<infer Name, any, any, any> ? Name : never;

/** @internal */
export type ImplementedEach<Name> = Name extends string ? Implemented<Name> : never;

/** Workflows a host lists whose implementation is missing from the Layer it's given. */
type Missing<ROut, Name> = Name extends string
  ? Implemented<Name> extends ROut
    ? never
    : Name
  : never;

type ImplementsAll<ROut, Name> = [Missing<ROut, Name>] extends [never]
  ? unknown
  : { readonly "Missing workflow implementations": Missing<ROut, Name> };

/**
 * A Lambda durable function that runs workflows: the class a
 * `WorkflowFunction` declares. `yield*` it for the Lambda function itself.
 */
export interface WorkflowFunctionClass<
  Self,
  W extends Workflow.Any = Workflow.Any,
> extends Effect.Effect<Function, never, Function["Providers"]> {
  readonly LogicalId: string;
  /** The workflows this function runs. */
  readonly workflows: ReadonlyArray<W>;
  /**
   * Deploy the function with the Layer that implements its workflows. The
   * Layer must implement every workflow the function lists.
   */
  make<ROut, E, RIn, PropsReq = never>(
    props:
      | InputProps<DurableFunctionProps>
      | Effect.Effect<InputProps<DurableFunctionProps>, ConfigError, PropsReq>,
    workflows: Layer.Layer<ROut, E, RIn> & ImplementsAll<ROut, WorkflowNames<W>>,
  ): Layer.Layer<
    Self,
    never,
    | Function["Providers"]
    | Exclude<PropsReq | RIn, DurableFunctionInitServices | WorkflowEngine.WorkflowEngine>
  >;
  new (_: never): {};
}

/**
 * A Lambda durable function that runs Effect workflows. Each run is one
 * durable execution of the function, named after the workflow and its
 * execution id.
 *
 * Steps run as durable steps, so a finished step's result is replayed rather
 * than run again. `DurableClock.sleep` is a durable wait: the invocation ends,
 * and Lambda invokes the function again when it's due, with no compute billed
 * in between. `DurableDeferred.await` waits for a callback, completed with a
 * run's `signal`. A workflow's child workflows run in the same function.
 *
 * Other functions start and read its runs with
 * {@link DurableFunctionEngine | AWS.Lambda.DurableFunctionEngine}.
 *
 * ### Declaring a workflow function
 * **Example:** One function for the order workflows
 * ```typescript
 * // src/OrderWorkflows.ts
 * import * as AWS from "alchemy/AWS";
 * import * as Layer from "effect/Layer";
 * import { PlaceOrder, PlaceOrderLive, RefundOrder, RefundOrderLive } from "./orders.ts";
 *
 * export class OrderWorkflows extends AWS.Lambda.WorkflowFunction<OrderWorkflows>()(
 *   "OrderWorkflows",
 *   { workflows: [PlaceOrder, RefundOrder] },
 * ) {}
 *
 * export default OrderWorkflows.make(
 *   { main: import.meta.url, executionTimeout: "7 days" },
 *   Layer.mergeAll(PlaceOrderLive, RefundOrderLive),
 * );
 * ```
 *
 * The Layer must implement every workflow the function lists: leaving one out
 * is a type error.
 *
 * @resource
 */
export const WorkflowFunction =
  <Self>() =>
  <const W extends ReadonlyArray<Workflow.Any>>(
    id: string,
    options: {
      /** The workflows this function runs. */
      readonly workflows: W;
    },
  ): WorkflowFunctionClass<Self, W[number]> => {
    const durable = (DurableFunction as any)()(id);
    const make = durable.make;
    // The Lambda function, from anywhere: its own init, or another function's.
    const self = (Function as any)()(id);
    return Object.assign(
      durable,
      {
        workflows: options.workflows,
        make: (props: unknown, workflows: Layer.Layer<any, any, any>) =>
          make(props, makeWorkflowRunner(workflows)),
      },
      Effectable.Prototype({
        label: `AWS.Lambda.WorkflowFunction<${id}>`,
        evaluate: () => self,
      }),
    );
  };
