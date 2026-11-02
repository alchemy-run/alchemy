import type * as automation from "@distilled.cloud/stackit/automation";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface GetVolumeTemplateRequest extends Omit<
  automation.GetVolumeTemplateRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for Automation `getVolumeTemplate`: read one of STACKIT's volume templates, with the kind of input it takes and the steps it runs.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope}), such as
 * a `VolumeAutomation` or a `Stackit.IaaS.Volume`, in a Function/Worker init phase and provide
 * {@link GetVolumeTemplateHttp}. Its project and region are injected into each request. The project needs the
 * service on: deploying a `VolumeAutomation` or a `Stackit.ServiceEnablement.Service` with the id
 * `cloud.stackit.automation` turns it on. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `automation-volumes.automation.get` on the project, so it reaches every
 * automation in that project: STACKIT binds roles on projects, folders and organizations, not
 * on a single automation. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Template
 * **Example:** Read a template's input kind
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
 *     const getVolumeTemplate = yield* Stackit.Automation.GetVolumeTemplate(yield* Nightly);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const template = yield* getVolumeTemplate({ templateId: "62c5178a-87fb-437f-88c8-c6f26b3ee4f6" });
 *         return yield* HttpServerResponse.json({ kind: template.input?.kind });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Automation.GetVolumeTemplateHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Automation
 * @category Automation
 */
export interface GetVolumeTemplate extends Binding.Service<
  GetVolumeTemplate,
  "Stackit.Automation.GetVolumeTemplate",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: GetVolumeTemplateRequest,
    ) => Effect.Effect<
      automation.GetVolumeTemplateResponse,
      automation.GetVolumeTemplateError,
      RuntimeContext
    >
  >
> {}

export const GetVolumeTemplate = Binding.Service<GetVolumeTemplate>(
  "Stackit.Automation.GetVolumeTemplate",
);
