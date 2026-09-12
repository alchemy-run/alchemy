import type * as script from "@distilled.cloud/gcp/script_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Deployment } from "./Deployment.ts";

export interface RunScriptsRequest extends Omit<
  script.RunScriptsRequest,
  "scriptId"
> {}

/**
 * Runtime binding for Apps Script `scripts.run`.
 *
 * Bind this operation to a {@link Deployment} in a Function/Action
 * init phase. Provide {@link RunScriptsHttp}. The API path uses the
 * deployment id (not the script project id) so the pinned version
 * executes.
 *
 * ### Running a Function
 * **Example:** Execute `hello`
 * ```typescript
 * const run = yield* GCP.Script.RunScripts(deployment);
 * const result = yield* run({
 *   body: { function: "hello", parameters: ["world"] },
 * });
 * ```
 *
 * @binding
 * @product GCP
 * @category Script
 */
export interface RunScripts extends Binding.Service<
  RunScripts,
  "GCP.Script.RunScripts",
  (
    deployment: Deployment,
  ) => Effect.Effect<
    (
      request: RunScriptsRequest,
    ) => Effect.Effect<script.Operation, script.RunScriptsError, RuntimeContext>
  >
> {}

export const RunScripts = Binding.Service<RunScripts>("GCP.Script.RunScripts");
