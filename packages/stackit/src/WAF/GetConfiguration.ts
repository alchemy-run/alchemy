import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Configuration } from "./Configuration.ts";

/**
 * Runtime binding for WAF `GetWAF`: read a WAF configuration's rule references
 * and which load balancers and listeners use it.
 *
 * Bind this operation to a {@link Configuration} in a Function/Worker init
 * phase and provide {@link GetConfigurationHttp}. The configuration's project,
 * region and name are injected into each request. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.waf.get` on the project holding the
 * configuration, so it reaches every configuration in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single
 * configuration. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Reading a Configuration
 * **Example:** Report usage from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Firewall = Stackit.WAF.Configuration("Firewall", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getConfiguration = yield* Stackit.WAF.GetConfiguration(yield* Firewall);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getConfiguration();
 *         return yield* HttpServerResponse.json({
 *           managedRuleSet: live.managedRuleSetName,
 *           usage: live.usage,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.GetConfigurationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface GetConfiguration extends Binding.Service<
  GetConfiguration,
  "Stackit.WAF.GetConfiguration",
  (
    firewall: Configuration,
  ) => Effect.Effect<() => Effect.Effect<waf.GetWAFResponse, waf.GetWAFError, RuntimeContext>>
> {}

export const GetConfiguration = Binding.Service<GetConfiguration>("Stackit.WAF.GetConfiguration");
