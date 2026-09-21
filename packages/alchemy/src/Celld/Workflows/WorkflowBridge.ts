import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { buildEventTelemetry } from "../../TelemetryRuntime.ts";
import { withWorkflowScope } from "../../Workers/WorkflowCallback.ts";
import { isScopeEjected } from "../../Cloudflare/Workers/HttpServer.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { WorkerEnvironment } from "../../Workers/Worker.ts";
import { getCelldWorkerExport } from "../WorkerBridge.ts";
import type { WorkflowExport } from "./Workflow.ts";
import {
  WorkflowEvent,
  WorkflowStep,
  workflowCall,
} from "./WorkflowRuntime.ts";
import type { NativeWorkflowStep } from "./WorkflowTypes.ts";

/** The runtime-provided base; constructors must not start workflow I/O. @internal */
export type WorkflowEntrypointClass = abstract new (
  ctx: unknown,
  env: unknown,
) => {
  run(
    event: WorkflowEvent["Service"],
    step: NativeWorkflowStep,
  ): Promise<unknown>;
};

/** Execute a native run under a fresh scope and close it with the real exit. @internal */
export const runWorkflow = (
  workflow: WorkflowExport,
  event: WorkflowEvent["Service"],
  step: NativeWorkflowStep,
  env: Record<string, unknown>,
  context: Context.Context<RuntimeContext>,
  telemetry?: Layer.Layer<never, any, any>,
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const memoMap = yield* Layer.makeMemoMap;
    return yield* workflow
      .run(event.payload)
      .pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(WorkflowEvent, event),
            Layer.succeed(WorkflowStep, step),
            Layer.succeed(WorkerEnvironment, env),
            Layer.succeed(Scope.Scope, scope),
            Layer.succeed(Layer.CurrentMemoMap, memoMap),
            Layer.effectContext(buildEventTelemetry(context, scope, telemetry)),
          ).pipe(Layer.provideMerge(Layer.succeedContext(context))),
        ),
      );
  }).pipe((effect) => withWorkflowScope(effect, isScopeEjected));

/** Build one statically exported workflow class, sharing only initialized services. @internal */
export const makeWorkflowBridge =
  (
    Base: WorkflowEntrypointClass,
    options: {
      entrypoint:
        | Effect.Effect<Record<string, any>>
        | Layer.Layer<any, any, any>;
      stack: { name: string; stage: string };
    },
  ) =>
  (className: string) => {
    const { build } = getCelldWorkerExport<WorkflowExport>({
      ...options,
      exportName: className,
    });
    return class WorkflowBridge extends Base {
      constructor(
        ctx: unknown,
        readonly env: Record<string, unknown>,
      ) {
        super(ctx, env);
      }

      run(
        event: WorkflowEvent["Service"],
        step: NativeWorkflowStep,
      ): Promise<unknown> {
        return workflowCall(() => build(() => {})).pipe(
          Effect.flatMap((built) =>
            runWorkflow(
              built.export,
              event,
              step,
              this.env,
              built.context,
              built.telemetry(),
            ),
          ),
          Effect.runPromise,
        );
      }
    };
  };
