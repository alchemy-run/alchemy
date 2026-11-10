import {
  makeDurableObjectEngine,
  type DurableObjectEngineHost,
} from "alchemy/Workers/DurableObjectEngine";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { WorkflowEngine } from "effect/workflow";
import { DurableObject, type DurableObjectJurisdiction } from "../Workers/DurableObject.ts";
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
 *         Layer.provideMerge(Cloudflare.Workflows.layerDurableObjectEngine()),
 *       ),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * ### Running executions in a jurisdiction
 * **Example:** Every execution in the EU
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Layer from "effect/Layer";
 * import { SendWelcomeLive } from "./SendWelcome.ts";
 *
 * const WorkflowsLive = SendWelcomeLive.pipe(
 *   Layer.provideMerge(Cloudflare.Workflows.layerDurableObjectEngine({ jurisdiction: "eu" })),
 * );
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Durable Objects
 */
export function layerDurableObjectEngine({
  jurisdiction,
}: DurableObjectEngineOptions = {}): Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> {
  // The same options return the same Layer, so providing it in several places
  // builds one engine.
  let engine = engines.get(jurisdiction);
  if (engine === undefined) engines.set(jurisdiction, (engine = makeEngine(jurisdiction)));
  return engine;
}

/** Options for {@link layerDurableObjectEngine}. */
export interface DurableObjectEngineOptions {
  /**
   * Create and store every workflow execution object only inside this
   * jurisdiction, e.g. `"eu"`. An execution in a jurisdiction is a different
   * object from the one with the same name outside it, so setting this does
   * not move executions that already exist.
   *
   * Enforced when deployed, not emulated in `alchemy dev` (local workerd does
   * not implement jurisdictions).
   *
   * @default undefined (no jurisdiction restriction)
   */
  readonly jurisdiction?: DurableObjectJurisdiction;
}

const engines = new Map<
  DurableObjectJurisdiction | undefined,
  Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker>
>();

type Declare = DurableObjectEngineHost<Worker, DurableObjectState>["declare"];

// The inline form of `Cloudflare.DurableObject` is typed for single-stage
// implementations; the engine declares the two-stage form it runs.
const declare = DurableObject as unknown as (
  ...args: Parameters<Declare>
) => Effect.Effect<
  ReturnType<Declare> extends Effect.Effect<infer N, any, any>
    ? N & { readonly jurisdiction: (jurisdiction: DurableObjectJurisdiction) => N }
    : never,
  never,
  Worker
>;

const makeEngine = (
  jurisdiction: DurableObjectJurisdiction | undefined,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> =>
  makeDurableObjectEngine({
    declare: (name, impl) =>
      Effect.map(declare(name, impl), (namespace) =>
        jurisdiction === undefined ? namespace : namespace.jurisdiction(jurisdiction),
      ),
    state: DurableObjectState,
  });
