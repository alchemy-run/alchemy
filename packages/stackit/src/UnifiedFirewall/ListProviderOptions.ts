import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

/**
 * Runtime binding for Unified Firewall `listProviderOptions`: list the products of a region, and
 * the rule types and actions each one takes.
 *
 * Bind this operation to any resource in that region (a {@link BindingScope}), such as a
 * `Stackit.UnifiedFirewall.Rule` or a `Stackit.IaaS.SecurityGroup`, in a Function/Worker init phase
 * and provide {@link ListProviderOptionsHttp}. Its region is injected into each request. It works
 * on any host. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: none. The spec turns authorization off for this operation, so no role is granted.
 *
 * ### Discovering Products
 * **Example:** List the products of the region
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
 *     const listProviderOptions = yield* Stackit.UnifiedFirewall.ListProviderOptions(yield* Web);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { products } = yield* listProviderOptions();
 *         return yield* HttpServerResponse.json({ products });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.ListProviderOptionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface ListProviderOptions extends Binding.Service<
  ListProviderOptions,
  "Stackit.UnifiedFirewall.ListProviderOptions",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    () => Effect.Effect<ufw.ProviderOptionsResponse, ufw.ListProviderOptionsError, RuntimeContext>
  >
> {}

export const ListProviderOptions = Binding.Service<ListProviderOptions>(
  "Stackit.UnifiedFirewall.ListProviderOptions",
);
