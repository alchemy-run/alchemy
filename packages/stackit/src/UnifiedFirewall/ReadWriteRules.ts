import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import type { ReadRulesClient } from "./ReadRules.ts";
import type { WriteRulesClient } from "./WriteRules.ts";

/** Every read and write operation on the rules of a bound project and region. */
export interface ReadWriteRulesClient extends ReadRulesClient, WriteRulesClient {}

/**
 * Read and change firewall rules of a project and region from a Function/Worker.
 *
 * Bind it in the init phase to any resource in that project and region (a {@link BindingScope})
 * and provide {@link ReadWriteRulesHttp}. Its project and region are injected into each request. A foreign
 * host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only the five `ufw.instance.*` permissions on the project, so it reaches every rule in that
 * project: STACKIT binds roles on projects, folders and organizations, not on a single rule. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading and Changing Rules
 * **Example:** Add a rule and read it back
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
 *     const rules = yield* Stackit.UnifiedFirewall.ReadWriteRules(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { refId } = yield* rules.createRule({ product: "edge-cloud", instanceId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", type: "ACL", sourceIP: "192.0.2.0/24" });
 *         const rule = yield* rules.getRule({ ruleId: refId! });
 *         return yield* HttpServerResponse.json({ status: rule.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.ReadWriteRulesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface ReadWriteRules extends Binding.Service<
  ReadWriteRules,
  "Stackit.UnifiedFirewall.ReadWriteRules",
  (scope: BindingScope) => Effect.Effect<ReadWriteRulesClient>
> {}

export const ReadWriteRules = Binding.Service<ReadWriteRules>(
  "Stackit.UnifiedFirewall.ReadWriteRules",
);
