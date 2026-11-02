import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface CreateRuleRequest extends Omit<ufw.CreateRuleRequest, "projectId" | "regionId"> {}

/**
 * Runtime binding for Unified Firewall `createRule`: add a rule at runtime, without a deploy. The rule isn't in any stack's state, so delete it with `DeleteRule` when it has done its job. It settles asynchronously: poll `GetRule` until `status` is `Active`.
 *
 * Bind this operation to any resource in that project and region (a {@link BindingScope}), such
 * as a `Stackit.UnifiedFirewall.Rule` or a `Stackit.IaaS.SecurityGroup`, in a Function/Worker init
 * phase and provide {@link CreateRuleHttp}. Its project and region are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ufw.instance.create` on the project, so it reaches every rule in
 * that project: STACKIT binds roles on projects, folders and organizations, not on a single rule.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Blocking at Runtime
 * **Example:** Add a rule during an incident
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Web = Stackit.IaaS.SecurityGroup("Web", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const createRule = yield* Stackit.UnifiedFirewall.CreateRule(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { refId } = yield* createRule({ product: "edge-cloud", instanceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", type: "ACL", sourceIP: "192.0.2.0/24" });
 *         return yield* HttpServerResponse.json({ refId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.CreateRuleHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface CreateRule extends Binding.Service<
  CreateRule,
  "Stackit.UnifiedFirewall.CreateRule",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: CreateRuleRequest,
    ) => Effect.Effect<ufw.CreateRuleResponse, ufw.CreateRuleError, RuntimeContext>
  >
> {}

export const CreateRule = Binding.Service<CreateRule>("Stackit.UnifiedFirewall.CreateRule");
