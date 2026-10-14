import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import type { Workflow } from "effect/workflow";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { type Implemented, implemented } from "./Implemented.ts";

type Requirements<L> = L extends Layer.Layer<any, any, infer R> ? R : never;

/**
 * Implement a workflow. Like `workflow.toLayer(execute)`, it registers the
 * handler with the engine, and it marks the workflow as implemented, so
 * `RunWorkflow` can run it.
 *
 * Handlers can call runtime-only APIs, like another Durable Object's methods.
 * `toLayer` puts everything a handler requires on the Layer it returns. A
 * runtime-only API requires `RuntimeContext`, which a Worker's or Lambda
 * function's init doesn't have. A handler only runs inside a run, and every
 * run has one, so this Layer doesn't ask for it.
 *
 * ### Implementing a workflow
 * **Example:** A step that calls a Durable Object
 * ```typescript
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Activity } from "effect/workflow";
 *
 * export const GreetLive = Layer.unwrap(
 *   Effect.gen(function* () {
 *     const journals = yield* Journal;
 *     return Workflows.layer(Greet, ({ name }) =>
 *       Activity.make({ name: "greet", execute: journals.getByName(name).append(name) }),
 *     );
 *   }),
 * );
 * ```
 *
 * @primitive
 */
export const layer = <
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
>(
  workflow: Workflow.Workflow<Name, Payload, Success, Error>,
  execute: (
    payload: Payload["Type"],
    executionId: string,
  ) => Effect.Effect<Success["Type"], Error["Type"], R>,
): Layer.Layer<
  Implemented<Name>,
  never,
  Exclude<Requirements<ReturnType<typeof workflow.toLayer<R>>>, RuntimeContext>
> =>
  Layer.merge(
    workflow.toLayer(execute) as Layer.Layer<
      never,
      never,
      Exclude<Requirements<ReturnType<typeof workflow.toLayer<R>>>, RuntimeContext>
    >,
    implemented([workflow._tag]),
  );
