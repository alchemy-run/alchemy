import type * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListConfigurationsRequest extends Omit<
  waf.ListWAFRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for WAF `ListWAF`: list one page of the WAF configurations
 * in a project and region. Pass `pageId` from a response's `nextPageId` to
 * read the next page.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link ListConfigurationsHttp}. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.waf.list` on the project of the
 * bound resource, the narrowest scope STACKIT binds roles on, so it reaches
 * that whole project. The deployer needs `iam.role.add` on that scope to
 * define the role.
 *
 * ### Listing Configurations
 * **Example:** List configuration names from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Network = Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listConfigurations = yield* Stackit.WAF.ListConfigurations(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listConfigurations({ pageSize: "50" });
 *         return yield* HttpServerResponse.json({
 *           names: (items ?? []).map((configuration) => configuration.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.ListConfigurationsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export interface ListConfigurations extends Binding.Service<
  ListConfigurations,
  "Stackit.WAF.ListConfigurations",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListConfigurationsRequest,
    ) => Effect.Effect<waf.ListWAFResponse, waf.ListWAFError, RuntimeContext>
  >
> {}

export const ListConfigurations = Binding.Service<ListConfigurations>(
  "Stackit.WAF.ListConfigurations",
);
