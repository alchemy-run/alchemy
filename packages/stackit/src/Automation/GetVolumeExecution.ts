import type * as automation from "@distilled.cloud/stackit/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VolumeAutomation } from "./VolumeAutomation.ts";

export interface GetVolumeExecutionRequest extends Omit<
  automation.GetVolumeExecutionRequest,
  "projectId" | "region" | "automationId"
> {}

/**
 * Runtime binding for Automation `getVolumeExecution`: read a run of the automation: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED` or `TERMINATED`, with the output of its steps. STACKIT's Go SDK waits up to 15 minutes for one to finish.
 *
 * Bind this operation to a {@link VolumeAutomation} in a Function/Worker init phase and provide
 * {@link GetVolumeExecutionHttp}. The automation's project, region and id are injected into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `automation-volumes.execution.get` on the project, so it reaches every
 * automation in that project: STACKIT binds roles on projects, folders and organizations, not
 * on a single automation. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Following a Run
 * **Example:** Read the status of a run
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Nightly = Stackit.Automation.VolumeAutomation("Nightly", {
 *   templateId: "62c5178a-87fb-437f-88c8-c6f26b3ee4f6",
 *   input: {
 *     volumeLabelSelector: "backup=nightly",
 *     snapshotRetentionPolicy: { kind: "count", value: 7 },
 *   },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getVolumeExecution = yield* Stackit.Automation.GetVolumeExecution(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const execution = yield* getVolumeExecution({ executionId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ status: execution.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Automation.GetVolumeExecutionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Automation
 * @category Automation
 */
export interface GetVolumeExecution extends Binding.Service<
  GetVolumeExecution,
  "Stackit.Automation.GetVolumeExecution",
  (
    volumeAutomation: VolumeAutomation,
  ) => Effect.Effect<
    (
      request: GetVolumeExecutionRequest,
    ) => Effect.Effect<
      automation.VolumeExecutionResponse,
      automation.GetVolumeExecutionError,
      RuntimeContext
    >
  >
> {}

export const GetVolumeExecution = Binding.Service<GetVolumeExecution>(
  "Stackit.Automation.GetVolumeExecution",
);
