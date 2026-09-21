import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { effectClass } from "../../Util/effect.ts";
import { WorkerEnvironment } from "../../Workers/Worker.ts";
import { Worker } from "../Worker.ts";
import {
  WorkflowEvent,
  WorkflowStep,
  workflowCall,
} from "./WorkflowRuntime.ts";
import type {
  NativeWorkflow,
  NativeWorkflowInstance,
  WorkflowHandle,
  WorkflowInstance,
} from "./WorkflowTypes.ts";

/** Services supplied afresh for each native run invocation. */
export type WorkflowRunServices =
  | WorkflowEvent
  | WorkflowStep
  | RuntimeContext
  | Scope.Scope
  | Layer.CurrentMemoMap;

/** Provider-specific export metadata consumed by the Celld generated entry. */
export interface WorkflowExport {
  /** Distinguishes these exports from Cloudflare workflows and Durable Objects. */
  readonly kind: "Celld.WorkflowExport";
  /** Run body, with initialization dependencies already captured. */
  readonly run: (
    input: unknown,
  ) => Effect.Effect<unknown, unknown, WorkflowRunServices>;
}

/** Detect Celld workflow metadata without interpreting other providers' exports. */
export const isWorkflowExport = (value: unknown): value is WorkflowExport =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  value.kind === "Celld.WorkflowExport";

/** Build lazy runtime operations; no native binding is read during init. @internal */
export const makeWorkflowHandle = <Input, Result>(
  name: string,
  get: () => NativeWorkflow<Input, Result>,
): WorkflowHandle<Input, Result> => ({
  Type: "Celld.Workflow",
  name,
  create: (options) =>
    workflowCall(() => get().create(options)).pipe(Effect.map(wrapInstance)),
  createBatch: (batch) =>
    workflowCall(() => get().createBatch(batch)).pipe(
      Effect.map((instances) => instances.map(wrapInstance)),
    ),
  get: (id) => workflowCall(() => get().get(id)).pipe(Effect.map(wrapInstance)),
  deleteBatch: (ids) => workflowCall(() => get().deleteBatch(ids)),
});

const wrapInstance = <Result>(
  instance: NativeWorkflowInstance<Result>,
): WorkflowInstance<Result> => ({
  id: instance.id,
  status: () => workflowCall(() => instance.status()),
  pause: () => workflowCall(() => instance.pause()),
  resume: () => workflowCall(() => instance.resume()),
  restart: (options) => workflowCall(() => instance.restart(options)),
  terminate: () => workflowCall(() => instance.terminate()),
  sendEvent: (event) => workflowCall(() => instance.sendEvent(event)),
  delete: () => workflowCall(() => instance.delete()),
});

const defineWorkflow = <Input, Result, E, R, InitE, InitR>(
  name: string,
  impl: Effect.Effect<
    (input: Input) => Effect.Effect<Result, E, R>,
    InitE,
    InitR
  >,
) =>
  effectClass(
    Effect.gen(function* () {
      const host = yield* Worker;
      const env = yield* WorkerEnvironment;
      const captured = yield* Effect.context<
        InitR | Exclude<R, WorkflowRunServices>
      >().pipe(Effect.map(Context.omit(Layer.CurrentMemoMap)));
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`Workflow(${name})`({
          bindings: [
            { type: "workflow", name, workflowName: name, className: name },
          ],
        });
      }
      const fn = yield* impl;
      yield* host.export(name, {
        kind: "Celld.WorkflowExport",
        run: (input: unknown) =>
          Effect.context<WorkflowRunServices>().pipe(
            Effect.flatMap((runtime) =>
              fn(input as Input).pipe(
                Effect.provide(Context.merge(captured, runtime)),
              ),
            ),
          ) as Effect.Effect<Result, E, WorkflowRunServices>,
      } satisfies WorkflowExport);
      return makeWorkflowHandle<Input, Result>(name, () => {
        const binding: NativeWorkflow<Input, Result> | undefined = env[name];
        if (!binding)
          throw new Error(`Celld workflow binding '${name}' is unavailable`);
        return binding;
      });
    }),
  );

function makeWorkflow<Self>(): typeof defineWorkflow;
function makeWorkflow<Input, Result, E, R, InitE, InitR>(
  name: string,
  impl: Effect.Effect<
    (input: Input) => Effect.Effect<Result, E, R>,
    InitE,
    InitR
  >,
): ReturnType<typeof defineWorkflow<Input, Result, E, R, InitE, InitR>>;
function makeWorkflow(
  name?: string,
  impl?: Effect.Effect<(input: any) => Effect.Effect<any, any, any>, any, any>,
) {
  return name === undefined ? defineWorkflow : defineWorkflow(name, impl!);
}

/**
 * Declare a native Celld Workflow in two phases: initialize binding clients, then
 * return the durable run body. Registration only contributes Worker metadata;
 * Application publishes the graph. Names are scoped to the hosting script.
 * Native Workflow schedules, rollback, and sensitive outputs are not supported.
 *
 * ### Define a workflow
 * **Example:** Capture initialization dependencies and run durable tasks
 * ```typescript
 * const reports = yield* Celld.Workflow("Reports", Effect.succeed(
 *   (input: { title: string }) => Celld.Workflows.task("report", Effect.succeed(input.title))));
 * // Inside a request handler:
 * const instance = yield* reports.create({ id: "daily-report", params: { title: "Daily" } });
 * ```
 *
 * ### Declare a reusable class
 * **Example:** Effect-native Workflow class
 * ```typescript
 * class Reports extends Celld.Workflow<Reports>()("Reports", Effect.succeed(
 *   (input: { title: string }) => Celld.Workflows.task("report", Effect.succeed(input.title)))) {}
 * ```
 *
 * @binding
 * @product Celld
 */
export const Workflow = makeWorkflow;
