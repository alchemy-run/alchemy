import type * as automation from "@distilled.cloud/stackit/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListVolumeTemplatesRequest extends Omit<
  automation.ListVolumeTemplatesRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for Automation `listVolumeTemplates`: list STACKIT's volume templates in a region, one page at a time, to find a `templateId`.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope}), such as
 * a `VolumeAutomation` or a `Stackit.IaaS.Volume`, in a Function/Worker init phase and provide
 * {@link ListVolumeTemplatesHttp}. Its project and region are injected into each request. The project needs the
 * service on: deploying a `VolumeAutomation` or a `Stackit.ServiceEnablement.Service` with the id
 * `cloud.stackit.automation` turns it on. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `automation-volumes.automation.list` on the project, so it reaches every
 * automation in that project: STACKIT binds roles on projects, folders and organizations, not
 * on a single automation. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Listing Templates
 * **Example:** List the templates of the region
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
 *     const listVolumeTemplates = yield* Stackit.Automation.ListVolumeTemplates(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listVolumeTemplates({ pageSize: 100 });
 *         return yield* HttpServerResponse.json({ templates: items.map((item) => item.id) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Automation.ListVolumeTemplatesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Automation
 * @category Automation
 */
export interface ListVolumeTemplates extends Binding.Service<
  ListVolumeTemplates,
  "Stackit.Automation.ListVolumeTemplates",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListVolumeTemplatesRequest,
    ) => Effect.Effect<
      automation.ListTemplatesResponse,
      automation.ListVolumeTemplatesError,
      RuntimeContext
    >
  >
> {}

export const ListVolumeTemplates = Binding.Service<ListVolumeTemplates>(
  "Stackit.Automation.ListVolumeTemplates",
);
