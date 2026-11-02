import type * as automation from "@distilled.cloud/stackit/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { VolumeAutomation } from "./VolumeAutomation.ts";

export interface ListVolumeExecutionsRequest extends Omit<
  automation.ListVolumeExecutionsRequest,
  "projectId" | "region" | "automationId"
> {}

/**
 * Runtime binding for Automation `listVolumeExecutions`: list the automation's runs, one page at a time.
 *
 * Bind this operation to a {@link VolumeAutomation} in a Function/Worker init phase and provide
 * {@link ListVolumeExecutionsHttp}. The automation's project, region and id are injected into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `automation-volumes.execution.list` on the project, so it reaches every
 * automation in that project: STACKIT binds roles on projects, folders and organizations, not
 * on a single automation. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Listing Runs
 * **Example:** List the automation's runs
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
 *     const listVolumeExecutions = yield* Stackit.Automation.ListVolumeExecutions(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listVolumeExecutions({ pageSize: 100 });
 *         return yield* HttpServerResponse.json({ runs: items.map((run) => run.status) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Automation.ListVolumeExecutionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Automation
 * @category Automation
 */
export interface ListVolumeExecutions extends Binding.Service<
  ListVolumeExecutions,
  "Stackit.Automation.ListVolumeExecutions",
  (
    volumeAutomation: VolumeAutomation,
  ) => Effect.Effect<
    (
      request?: ListVolumeExecutionsRequest,
    ) => Effect.Effect<
      automation.ListExecutionsResponse,
      automation.ListVolumeExecutionsError,
      RuntimeContext
    >
  >
> {}

export const ListVolumeExecutions = Binding.Service<ListVolumeExecutions>(
  "Stackit.Automation.ListVolumeExecutions",
);
