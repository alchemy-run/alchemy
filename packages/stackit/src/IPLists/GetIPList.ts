import type * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IPList } from "./IPList.ts";

/**
 * Runtime binding for IP Lists `GetIPList`: read an IP list's entry count,
 * content hash and which load balancers use it. STACKIT never returns the
 * CIDRs.
 *
 * Bind this operation to an {@link IPList} in a Function/Worker init phase and
 * provide {@link GetIPListHttp}. The IP list's project, region and name are
 * injected into each request. It works on any host. A foreign host signs with
 * a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `lb-ip-lists.loadbalancer.get` on the
 * project holding the IP list, so it reaches every IP list in that project:
 * STACKIT binds roles on projects, folders and organizations, not on a single
 * IP list. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading a List
 * **Example:** Report the entry count from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Blocked = Stackit.IPLists.IPList("Blocked", {
 *   cidrs: ["198.51.100.0/24"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getIPList = yield* Stackit.IPLists.GetIPList(yield* Blocked);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const list = yield* getIPList();
 *         return yield* HttpServerResponse.json({
 *           entries: list.numberOfIps,
 *           usage: list.usage,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IPLists.GetIPListHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Load Balancer IP Lists
 * @category IPLists
 */
export interface GetIPList extends Binding.Service<
  GetIPList,
  "Stackit.IPLists.GetIPList",
  (
    list: IPList,
  ) => Effect.Effect<
    () => Effect.Effect<ipLists.GetIPListResponse, ipLists.GetIPListError, RuntimeContext>
  >
> {}

export const GetIPList = Binding.Service<GetIPList>("Stackit.IPLists.GetIPList");
