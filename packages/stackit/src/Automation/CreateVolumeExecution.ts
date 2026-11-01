import type * as automation from "@distilled.cloud/stackit/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VolumeAutomation } from "./VolumeAutomation.ts";

export interface CreateVolumeExecutionRequest extends Omit<
  automation.CreateVolumeExecutionRequest,
  "projectId" | "region" | "automationId"
> {}

/**
 * Runtime binding for Automation `createVolumeExecution`: run the automation now, outside its schedule. The run creates recovery points, which bill as snapshot storage.
 *
 * Bind this operation to a {@link VolumeAutomation} in a Function/Worker init phase and provide
 * {@link CreateVolumeExecutionHttp}. The automation's project, region and id are injected into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `automation-volumes.execution.create` on the project, so it reaches every
 * automation in that project: STACKIT binds roles on projects, folders and organizations, not
 * on a single automation. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Running the Automation
 * **Example:** Take a recovery point now
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
 *     const createVolumeExecution = yield* Stackit.Automation.CreateVolumeExecution(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const execution = yield* createVolumeExecution();
 *         return yield* HttpServerResponse.json({ id: execution.id, status: execution.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Automation.CreateVolumeExecutionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Automation
 * @category Automation
 */
export interface CreateVolumeExecution extends Binding.Service<
  CreateVolumeExecution,
  "Stackit.Automation.CreateVolumeExecution",
  (
    volumeAutomation: VolumeAutomation,
  ) => Effect.Effect<
    (
      request?: CreateVolumeExecutionRequest,
    ) => Effect.Effect<
      automation.VolumeExecutionResponse,
      automation.CreateVolumeExecutionError,
      RuntimeContext
    >
  >
> {}

export const CreateVolumeExecution = Binding.Service<CreateVolumeExecution>(
  "Stackit.Automation.CreateVolumeExecution",
);
