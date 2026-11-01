import type * as cdn from "@distilled.cloud/stackit/cdn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

export interface ListWafCollectionsRequest extends Omit<
  cdn.ListWafCollectionsRequest,
  "projectId"
> {}

/**
 * Runtime binding for CDN `ListWafCollections`: list the web application firewall rule collections available to a project.
 *
 * Bind this operation to any resource with a `projectId` attribute, such as a {@link Distribution}, in a Function/Worker init phase and provide
 * {@link ListWafCollectionsHttp}. The resource's project are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `cdn.distribution.get` on the project holding
 * the bound resource, so it reaches every distribution in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single
 * distribution. The deployer needs `iam.role.add` on that scope to define the
 * role.
 *
 * ### Listing WAF Rules
 * **Example:** List the rule collections from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Cdn = Stackit.CDN.Distribution("Cdn", {
 *   backend: { type: "http", originUrl: "https://origin.example.com" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listWafCollections = yield* Stackit.CDN.ListWafCollections(yield* Cdn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { collections } = yield* listWafCollections();
 *         return yield* HttpServerResponse.json({ ids: collections.map((item) => item.id) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.ListWafCollectionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT CDN
 * @category CDN
 */
export interface ListWafCollections extends Binding.Service<
  ListWafCollections,
  "Stackit.CDN.ListWafCollections",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListWafCollectionsRequest,
    ) => Effect.Effect<cdn.ListWafCollectionsResponse, cdn.ListWafCollectionsError, RuntimeContext>
  >
> {}

export const ListWafCollections = Binding.Service<ListWafCollections>(
  "Stackit.CDN.ListWafCollections",
);
