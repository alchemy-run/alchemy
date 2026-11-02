import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Configuration } from "./Configuration.ts";

export interface UpdateConfigurationRequest extends Omit<
  waf.UpdateWAFRequest,
  "projectId" | "region" | "name"
> {}

/**
 * Runtime binding for WAF `UpdateWAF`: change which rules a WAF configuration
 * applies from deployed code, for example to switch rule sets during an
 * incident. STACKIT also applies the change to every load balancer using it.
 * The request is the configuration's new full content: a reference you leave
 * out may be cleared, so send both. When `labels` is left out, the labels it
 * has are kept, including Alchemy's ownership labels.
 *
 * A change made this way drifts from the {@link Configuration}'s props: the
 * next update of that resource sends the declared references. A deploy that
 * leaves the props unchanged doesn't touch it.
 *
 * Bind this operation to a {@link Configuration} in a Function/Worker init
 * phase and provide {@link UpdateConfigurationHttp}. The configuration's
 * project, region and name are injected into each request. It works on any
 * host. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role holding only `alb.waf.get` and `alb.waf.update` on the
 * project holding the configuration, so it reaches every configuration in that
 * project: STACKIT binds roles on projects, folders and organizations, not on
 * a single configuration. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Updating a Configuration
 * **Example:** Switch the managed rule set from a Cloudflare Worker
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
 *     const updateConfiguration = yield* Stackit.WAF.UpdateConfiguration(yield* Firewall);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateConfiguration({ managedRuleSetName: "incident-rules" });
 *         return yield* HttpServerResponse.json({ managedRuleSet: live.managedRuleSetName });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.UpdateConfigurationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface UpdateConfiguration extends Binding.Service<
  UpdateConfiguration,
  "Stackit.WAF.UpdateConfiguration",
  (
    firewall: Configuration,
  ) => Effect.Effect<
    (
      request: UpdateConfigurationRequest,
    ) => Effect.Effect<waf.GetWAFResponse, waf.GetWAFError | waf.UpdateWAFError, RuntimeContext>
  >
> {}

export const UpdateConfiguration = Binding.Service<UpdateConfiguration>(
  "Stackit.WAF.UpdateConfiguration",
);
