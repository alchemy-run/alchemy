import {
  makeDurableObjectEngine,
  type DurableObjectEngineHost,
} from "alchemy/Workers/DurableObjectEngine";
import type * as Layer from "effect/Layer";
import type { WorkflowEngine } from "effect/workflow";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import type { Worker } from "../Workers/Worker.ts";

/**
 * Runs Effect workflows on Durable Objects. Each workflow gets its own Durable
 * Object class on the host Worker, and each execution is one instance of it,
 * named by its execution id, with its journal in that instance's SQLite.
 *
 * A run replays the workflow from the top: finished activities return their
 * stored results, and the first unfinished one runs and is stored. A run that
 * waits on a `DurableClock` or `DurableDeferred` that isn't ready suspends,
 * and the clock firing or the deferred being completed runs it again. Every
 * run happens in one durable callback per execution, so runs never overlap,
 * and a run that fails or is cut short is retried.
 *
 * ### Running workflows on Durable Objects
 * **Example:** Provide the engine to a Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Schema from "effect/Schema";
 * import { Activity, Workflow } from "effect/workflow";
 *
 * const SendWelcome = Workflow.make("SendWelcome", {
 *   payload: { userId: Schema.String },
 *   idempotencyKey: ({ userId }) => userId,
 * });
 *
 * const SendWelcomeLive = Workflows.layer(
 *   SendWelcome,
 *   Effect.fn(function* ({ userId }) {
 *     yield* Activity.make({ name: "send", execute: Effect.log(`welcome, ${userId}`) });
 *   }),
 * );
 *
 * export default class AppWorker extends Cloudflare.Worker<AppWorker>()(
 *   "AppWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const welcome = yield* Workflows.RunWorkflow(SendWelcome);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* welcome.start({ userId: "u-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       SendWelcomeLive.pipe(
 *         Layer.provideMerge(Cloudflare.Workflows.DurableObjectEngine),
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Durable Objects
 */
export const DurableObjectEngine: Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> =
  makeDurableObjectEngine({
    // The inline form of `Cloudflare.DurableObject` is typed for single-stage
    // implementations; the engine declares the two-stage form it runs.
    declare: DurableObject as unknown as DurableObjectEngineHost<
      Worker,
      DurableObjectState
    >["declare"],
    state: DurableObjectState,
  });
