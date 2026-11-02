import type * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { IPList } from "./IPList.ts";

export interface UploadIPListRequest extends Omit<
  ipLists.UploadIPListRequest,
  "projectId" | "region" | "name"
> {}

/**
 * Runtime binding for IP Lists `UploadIPList`: replace an IP list's content
 * from deployed code, for example to refresh it from a threat feed.
 * `fileContent` is a newline-separated list of IPv4 CIDRs, or a CSV with a
 * `cidr` column. STACKIT accepts one upload a minute and fails others with
 * `TooManyRequests`. When `labels` is left out, the labels it has are kept,
 * including Alchemy's ownership labels.
 *
 * An upload overwrites what the {@link IPList} declares in `cidrs`: the next
 * update of that resource, which any change to its `cidrs` or labels runs,
 * sends the declared CIDRs again. For a list a runtime owns, declare a small
 * seed and leave the props unchanged. A deploy that leaves them unchanged
 * doesn't touch the content.
 *
 * Bind this operation to an {@link IPList} in a Function/Worker init phase and
 * provide {@link UploadIPListHttp}. The IP list's project, region and name are
 * injected into each request. It works on any host. A foreign host signs with
 * a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `lb-ip-lists.loadbalancer.get` and
 * `lb-ip-lists.loadbalancer.upload` on the project holding the IP list, so it
 * reaches every IP list in that project: STACKIT binds roles on projects,
 * folders and organizations, not on a single IP list. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Uploading a List
 * **Example:** Refresh the list from a Cloudflare Worker
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
 *     const uploadIPList = yield* Stackit.IPLists.UploadIPList(yield* Blocked);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const list = yield* uploadIPList({
 *           fileContent: "198.51.100.0/24\n203.0.113.0/24",
 *         });
 *         return yield* HttpServerResponse.json({ entries: list.numberOfIps });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IPLists.UploadIPListHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Load Balancer IP Lists
 * @category IPLists
 */
export interface UploadIPList extends Binding.Service<
  UploadIPList,
  "Stackit.IPLists.UploadIPList",
  (
    list: IPList,
  ) => Effect.Effect<
    (
      request: UploadIPListRequest,
    ) => Effect.Effect<
      ipLists.GetIPListResponse,
      ipLists.GetIPListError | ipLists.UploadIPListError,
      RuntimeContext
    >
  >
> {}

export const UploadIPList = Binding.Service<UploadIPList>("Stackit.IPLists.UploadIPList");
