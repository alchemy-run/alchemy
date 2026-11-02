import type * as automation from "@distilled.cloud/stackit/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VolumeAutomation } from "./VolumeAutomation.ts";

export interface GetVolumeAutomationRequest extends Omit<
  automation.GetVolumeAutomationRequest,
  "projectId" | "region" | "automationId"
> {}

/**
 * Runtime binding for Automation `getVolumeAutomation`: read the automation's name, input, schedule and step output.
 *
 * Bind this operation to a {@link VolumeAutomation} in a Function/Worker init phase and provide
 * {@link GetVolumeAutomationHttp}. The automation's project, region and id are injected into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `automation-volumes.automation.get` on the project, so it reaches every
 * automation in that project: STACKIT binds roles on projects, folders and organizations, not
 * on a single automation. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Automation
 * **Example:** Read the automation's schedule
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
 *     const getVolumeAutomation = yield* Stackit.Automation.GetVolumeAutomation(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getVolumeAutomation();
 *         return yield* HttpServerResponse.json({ schedule: live.triggers?.schedule?.rrule });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Automation.GetVolumeAutomationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Automation
 * @category Automation
 */
export interface GetVolumeAutomation extends Binding.Service<
  GetVolumeAutomation,
  "Stackit.Automation.GetVolumeAutomation",
  (
    volumeAutomation: VolumeAutomation,
  ) => Effect.Effect<
    (
      request?: GetVolumeAutomationRequest,
    ) => Effect.Effect<
      automation.VolumeAutomation,
      automation.GetVolumeAutomationError,
      RuntimeContext
    >
  >
> {}

export const GetVolumeAutomation = Binding.Service<GetVolumeAutomation>(
  "Stackit.Automation.GetVolumeAutomation",
);
