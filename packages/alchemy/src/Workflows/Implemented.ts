import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

declare const ImplementedTypeId: unique symbol;

/**
 * Marks a workflow as runnable here: something in the context implements it.
 * `Workflows.layer` provides it for the workflow it implements, and a remote
 * engine, like `AWS.Lambda.DurableFunctionEngine`, for the workflows its
 * hosts run. `Workflows.RunWorkflow` requires it, so running a workflow
 * nothing implements is a type error.
 */
export interface Implemented<Name extends string> {
  readonly [ImplementedTypeId]: Name;
}

/** @internal */
export const Implemented = <Name extends string>(name: Name) =>
  Context.Service<Implemented<Name>, true>(`alchemy/Workflows/Implemented/${name}`);

/** @internal */
export const implemented = <Name extends string>(
  names: ReadonlyArray<Name>,
): Layer.Layer<Implemented<Name>> =>
  Layer.succeedContext(
    names.reduce(
      (context, name) => Context.add(context, Implemented(name), true),
      Context.empty() as Context.Context<Implemented<Name>>,
    ),
  );
