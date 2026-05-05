import * as workflows from "@distilled.cloud/cloudflare/workflows";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { PlatformServices } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { effectClass, taggedFunction } from "../../Util/effect.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { Worker, WorkerEnvironment, type WorkerServices } from "./Worker.ts";

type WorkflowTypeId = "Cloudflare.Workflow";
const WorkflowTypeId: WorkflowTypeId = "Cloudflare.Workflow";

// ---------------------------------------------------------------------------
// Runtime services -- provided by the bridge when the workflow executes
// ---------------------------------------------------------------------------

/**
 * Service that carries the current workflow event payload.
 * `yield* WorkflowEvent` inside a workflow body to access it.
 */
export class WorkflowEvent extends Context.Service<
  WorkflowEvent,
  {
    payload: unknown;
    timestamp: Date;
    instanceId: string;
  }
>()("Cloudflare.WorkflowEvent") {}

/**
 * Internal service that wraps the Cloudflare `WorkflowStep` object.
 * Not accessed directly by users -- use `task`, `sleep`, `sleepUntil` instead.
 */
export class WorkflowStep extends Context.Service<
  WorkflowStep,
  {
    do<T>(name: string, effect: Effect.Effect<T>): Effect.Effect<T>;
    sleep(name: string, duration: string | number): Effect.Effect<void>;
    sleepUntil(name: string, timestamp: Date | number): Effect.Effect<void>;
  }
>()("Cloudflare.WorkflowStep") {}

// ---------------------------------------------------------------------------
// User-facing step primitives
// ---------------------------------------------------------------------------

/**
 * Execute a named, durable workflow step. The effect is run inside the
 * Cloudflare step transaction so its result is automatically persisted
 * and replayed on retries.
 */
export const task = <T>(
  name: string,
  effect: Effect.Effect<T>,
): Effect.Effect<T, never, WorkflowStep> =>
  WorkflowStep.asEffect().pipe(Effect.flatMap((step) => step.do(name, effect)));

/**
 * Pause the workflow for the given duration.
 */
export const sleep = (
  name: string,
  duration: string | number,
): Effect.Effect<void, never, WorkflowStep> =>
  WorkflowStep.asEffect().pipe(
    Effect.flatMap((step) => step.sleep(name, duration)),
    Effect.orDie,
  );

/**
 * Pause the workflow until the given timestamp.
 */
export const sleepUntil = (
  name: string,
  timestamp: Date | number,
): Effect.Effect<void, never, WorkflowStep> =>
  WorkflowStep.asEffect().pipe(
    Effect.flatMap((step) => step.sleepUntil(name, timestamp)),
    Effect.orDie,
  );

/**
 * The services available inside a workflow run body.
 *
 * `WorkerEnvironment` is provided to the body at runtime by the workflow
 * export wrapper (see `make(env)` below), so users can access env bindings
 * from inside workflow steps via `yield* WorkerEnvironment` — the type must
 * reflect that or `yield* WorkerEnvironment` fails to type-check inside a
 * body even though it succeeds at runtime.
 */
export type WorkflowRunServices =
  | WorkflowEvent
  | WorkflowStep
  | WorkerEnvironment;

export type WorkflowServices = WorkerServices | PlatformServices;

/**
 * Metadata stored in the worker export map to distinguish workflow exports
 * from durable object exports at bundle-generation time.
 */
export interface WorkflowExport {
  readonly kind: "workflow";
  readonly make: (
    env: unknown,
  ) => Effect.Effect<Effect.Effect<unknown, never, WorkflowRunServices>>;
}

/**
 * A workflow body is an Effect that requires WorkflowRunServices
 * (event + step) to execute.
 */
export type WorkflowBody<Result = unknown> = Effect.Effect<
  Result,
  never,
  WorkflowRunServices
>;

export const isWorkflowExport = (value: unknown): value is WorkflowExport =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as any).kind === "workflow";

/**
 * Type guard for workflow binding metadata in the Worker binding contract.
 */
export const isWorkflowBinding = (binding: {
  type: string;
}): binding is {
  type: "workflow";
  name: string;
  workflowName: string;
  className: string;
  scriptName?: string;
} => binding.type === "workflow";

/**
 * Handle returned to the caller at deploy/bind time. Allows starting
 * workflow instances and checking their status from the Api layer.
 */
export interface WorkflowHandle<Params = unknown> {
  Type: WorkflowTypeId;
  name: string;
  create(params?: Params): Effect.Effect<WorkflowInstance>;
  get(instanceId: string): Effect.Effect<WorkflowInstance>;
}

export interface WorkflowInstance {
  id: string;
  status(): Effect.Effect<WorkflowInstanceStatus>;
  pause(): Effect.Effect<void>;
  resume(): Effect.Effect<void>;
  terminate(): Effect.Effect<void>;
}

export interface WorkflowInstanceStatus {
  status: string;
  output?: unknown;
  error?: { name: string; message: string } | null;
}

export interface WorkflowClass extends Effect.Effect<
  WorkflowHandle,
  never,
  WorkflowHandle
> {
  <_Self>(): {
    <Result = unknown, InitReq = never>(
      name: string,
      impl: Effect.Effect<WorkflowBody<Result>, never, InitReq>,
    ): Effect.Effect<
      WorkflowHandle,
      never,
      Worker | Exclude<InitReq, WorkflowServices>
    > & {
      new (_: never): WorkflowBody<Result>;
    };
  };
  <Result = unknown, InitReq = never>(
    name: string,
    impl: Effect.Effect<WorkflowBody<Result>, never, InitReq>,
  ): Effect.Effect<
    WorkflowHandle,
    never,
    Worker | Exclude<InitReq, WorkflowServices>
  >;
}

export class WorkflowScope extends Context.Service<
  WorkflowScope,
  WorkflowHandle
>()("Cloudflare.Workflow") {}

/**
 * A Cloudflare Workflow that orchestrates durable, multi-step tasks with
 * automatic retries and at-least-once delivery.
 *
 * A Workflow follows the same two-phase pattern as Workers and Durable
 * Objects. The outer `Effect.gen` resolves shared dependencies. The inner
 * `Effect.gen` is the workflow body — it reads the triggering event and
 * runs steps using `task`, `sleep`, and `sleepUntil`.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   // Phase 1: resolve dependencies
 *   const notifier = yield* NotificationService;
 *
 *   return Effect.gen(function* () {
 *     // Phase 2: workflow body (durable steps)
 *     const event = yield* Cloudflare.WorkflowEvent;
 *     const result = yield* Cloudflare.task("process", doWork(event.payload));
 *     yield* Cloudflare.sleep("cooldown", "10 seconds");
 *     return result;
 *   });
 * })
 * ```
 *
 * @resource
 *
 * @section Defining a Workflow
 * @example Minimal workflow
 * ```typescript
 * export default class MyWorkflow extends Cloudflare.Workflow<MyWorkflow>()(
 *   "MyWorkflow",
 *   Effect.gen(function* () {
 *     return Effect.gen(function* () {
 *       const event = yield* Cloudflare.WorkflowEvent;
 *       return { received: event.payload };
 *     });
 *   }),
 * ) {}
 * ```
 *
 * @section Step Primitives
 * @example Running a named task
 * ```typescript
 * const result = yield* Cloudflare.task(
 *   "process-order",
 *   Effect.succeed({ orderId: "abc", total: 42 }),
 * );
 * ```
 *
 * @example Sleeping between steps
 * ```typescript
 * yield* Cloudflare.sleep("cooldown", "30 seconds");
 * ```
 *
 * @example Accessing env bindings inside a step
 * `Cloudflare.WorkerEnvironment` is the same service available
 * inside a Worker — it gives you typed access to env bindings (KV,
 * R2, etc.) from inside a workflow body. Wrap any side-effecting
 * call in `task` so the result is persisted across replays.
 *
 * ```typescript
 * Effect.gen(function* () {
 *   const env = yield* Cloudflare.WorkerEnvironment;
 *   const event = yield* Cloudflare.WorkflowEvent;
 *   const { roomId, message } = event.payload as {
 *     roomId: string;
 *     message: string;
 *   };
 *
 *   const stored = yield* Cloudflare.task(
 *     "kv-roundtrip",
 *     Effect.tryPromise({
 *       try: async () => {
 *         await env.KV.put(`workflow:${roomId}`, message);
 *         return await env.KV.get(`workflow:${roomId}`);
 *       },
 *       catch: (cause) =>
 *         cause instanceof Error ? cause : new Error(String(cause)),
 *     }).pipe(Effect.orDie),
 *   );
 *   return stored;
 * });
 * ```
 *
 * @section Starting and Monitoring Instances
 * @example Creating an instance from a Worker
 * ```typescript
 * const workflow = yield* MyWorkflow;
 * const instance = yield* workflow.create({ orderId: "abc" });
 * ```
 *
 * @example Checking instance status
 * ```typescript
 * const workflow = yield* MyWorkflow;
 * const handle = yield* workflow.get(instanceId);
 * const status = yield* handle.status();
 * ```
 *
 * @section Triggering from a Worker
 * Wire the workflow into HTTP routes so callers can fire instances
 * and poll for completion.
 *
 * @example Workflow start + status routes
 * ```typescript
 * // src/worker.ts
 * const notifier = yield* MyWorkflow;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *
 *     if (request.url.startsWith("/workflow/start/")) {
 *       const id = request.url.split("/").pop()!;
 *       const instance = yield* notifier.create({ id });
 *       return HttpServerResponse.json({ instanceId: instance.id });
 *     }
 *
 *     if (request.url.startsWith("/workflow/status/")) {
 *       const id = request.url.split("/").pop()!;
 *       const instance = yield* notifier.get(id);
 *       return HttpServerResponse.json(yield* instance.status());
 *     }
 *
 *     return HttpServerResponse.text("Not Found", { status: 404 });
 *   }),
 * };
 * ```
 *
 * @section Testing Workflows
 * Workflows run asynchronously, so tests start an instance and
 * poll until it reaches a terminal status. A simple recipe with
 * `alchemy/Test/Bun`:
 *
 * @example Polling for workflow completion
 * ```typescript
 * test(
 *   "workflow completes",
 *   Effect.gen(function* () {
 *     const { url } = yield* stack;
 *
 *     const start = yield* HttpClient.post(`${url}/workflow/start/x`);
 *     const { instanceId } = (yield* start.json) as { instanceId: string };
 *
 *     let status: { status: string } | undefined;
 *     const deadline = Date.now() + 60_000;
 *     while (Date.now() < deadline) {
 *       const res = yield* HttpClient.get(
 *         `${url}/workflow/status/${instanceId}`,
 *       );
 *       status = (yield* res.json) as { status: string };
 *       if (status.status === "complete" || status.status === "errored") {
 *         break;
 *       }
 *       yield* Effect.sleep("2 seconds");
 *     }
 *
 *     expect(status?.status).toBe("complete");
 *   }),
 *   { timeout: 120_000 },
 * );
 * ```
 */
export const Workflow: WorkflowClass = taggedFunction(WorkflowScope, ((
  ...args: [] | [name: string, impl: Effect.Effect<WorkflowBody>]
) =>
  args.length === 0
    ? Workflow
    : effectClass(
        Effect.gen(function* () {
          const [name, impl] = args;
          const worker = yield* Worker;

          // Add the workflow binding to the Worker metadata
          yield* worker.bind`${name}`({
            bindings: [
              {
                type: "workflow",
                name,
                workflowName: name,
                className: name,
              },
            ],
          });

          // Create the Workflow API resource (putWorkflow / deleteWorkflow)
          yield* WorkflowResource(name, {
            workflowName: name,
            className: name,
            scriptName: worker.workerName,
          });

          const services =
            yield* Effect.context<Effect.Services<typeof impl>>();

          const binding = yield* Effect.serviceOption(WorkerEnvironment).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.flatMap((env) => {
              if (env === undefined) {
                return Effect.succeed(undefined as any);
              }
              const wf = env[name];
              if (!wf) {
                return Effect.die(
                  new Error(`Workflow '${name}' not found in env`),
                );
              }
              return Effect.succeed(wf);
            }),
          );

          const self: WorkflowHandle = {
            Type: WorkflowTypeId,
            name,
            create: (params?: unknown) =>
              Effect.tryPromise(() => binding.create({ params })).pipe(
                Effect.map(wrapInstance),
                Effect.orDie,
              ),
            get: (instanceId: string) =>
              Effect.tryPromise(() => binding.get(instanceId)).pipe(
                Effect.map(wrapInstance),
                Effect.orDie,
              ),
          };

          const body = yield* impl.pipe(
            Effect.provideService(WorkflowScope, self as any),
          );

          yield* worker.export(name, {
            kind: "workflow",
            make: (env: unknown) =>
              Effect.succeed(
                body.pipe(
                  Effect.provideService(
                    WorkerEnvironment,
                    env as Record<string, any>,
                  ),
                ),
              ).pipe(Effect.provideContext(services)),
          } satisfies WorkflowExport);

          return self;
        }),
      )) as any);

// ---------------------------------------------------------------------------
// WorkflowResource -- manages the Cloudflare Workflows API lifecycle
// ---------------------------------------------------------------------------

export interface WorkflowResourceProps {
  workflowName: string;
  className: string;
  scriptName: string;
}

export interface WorkflowResourceAttrs {
  workflowId: string;
  workflowName: string;
  className: string;
  scriptName: string;
  accountId: string;
}

const WorkflowResourceTypeId = "Cloudflare.Workflow";

export interface WorkflowResource extends Resource<
  typeof WorkflowResourceTypeId,
  WorkflowResourceProps,
  WorkflowResourceAttrs
> {}

export const WorkflowResource = Resource<WorkflowResource>(
  WorkflowResourceTypeId,
);

export const WorkflowProvider = () =>
  Provider.effect(
    WorkflowResource,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const putWorkflow = yield* workflows.putWorkflow;
      const deleteWorkflow = yield* workflows.deleteWorkflow;

      return WorkflowResource.Provider.of({
        stables: ["workflowId", "accountId"],
        reconcile: Effect.fnUntraced(function* ({ news, output }) {
          const acct = output?.accountId ?? accountId;
          yield* Effect.logInfo(
            `Cloudflare Workflow reconcile: ${news.workflowName}`,
          );
          // Cloudflare's `putWorkflow` is a true PUT-as-upsert: identical
          // payloads converge to the same state and a missing workflow is
          // created on the spot. There is no separate observe step needed
          // — the API is naturally reconciler-shaped.
          const result = yield* putWorkflow({
            accountId: acct,
            workflowName: news.workflowName,
            className: news.className,
            scriptName: news.scriptName,
          });
          return {
            workflowId: result.id,
            workflowName: result.name,
            className: result.className,
            scriptName: result.scriptName,
            accountId: acct,
          };
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* Effect.logInfo(
            `Cloudflare Workflow delete: ${output.workflowName}`,
          );
          yield* deleteWorkflow({
            accountId: output.accountId,
            workflowName: output.workflowName,
          }).pipe(Effect.catchTag("WorkflowNotFound", () => Effect.void));
        }),
      });
    }),
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const wrapInstance = (raw: any): WorkflowInstance => ({
  id: raw.id,
  status: () =>
    Effect.tryPromise(() => raw.status()).pipe(
      Effect.map((s: any) => ({
        status: s.status as string,
        output: s.output,
        error: s.error,
      })),
      Effect.orDie,
    ),
  pause: () => Effect.tryPromise(() => raw.pause()).pipe(Effect.orDie),
  resume: () => Effect.tryPromise(() => raw.resume()).pipe(Effect.orDie),
  terminate: () => Effect.tryPromise(() => raw.terminate()).pipe(Effect.orDie),
});
