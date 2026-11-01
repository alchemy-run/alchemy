import type * as cdn from "@distilled.cloud/stackit/cdn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

export interface ListDistributionsRequest extends Omit<cdn.ListDistributionsRequest, "projectId"> {}

/**
 * Runtime binding for CDN `ListDistributions`: list the distributions of a project.
 *
 * Bind this operation to any resource with a `projectId` attribute, such as a {@link Distribution}, in a Function/Worker init phase and provide
 * {@link ListDistributionsHttp}. The resource's project are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `cdn.distribution.get` and
 * `cdn.distribution.list` on the project holding the bound resource, so it reaches
 * every distribution in that project: STACKIT binds roles on projects, folders and
 * organizations, not on a single distribution. The deployer needs `iam.role.add`
 * on that scope to define the role.
 *
 * ### Listing Distributions
 * **Example:** List the project's distributions from a Cloudflare Worker
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
 *     const listDistributions = yield* Stackit.CDN.ListDistributions(yield* Cdn);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { distributions } = yield* listDistributions({ pageSize: 100 });
 *         return yield* HttpServerResponse.json({ ids: distributions.map((item) => item.id) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.ListDistributionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT CDN
 * @category CDN
 */
export interface ListDistributions extends Binding.Service<
  ListDistributions,
  "Stackit.CDN.ListDistributions",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListDistributionsRequest,
    ) => Effect.Effect<cdn.ListDistributionsResponse, cdn.ListDistributionsError, RuntimeContext>
  >
> {}

export const ListDistributions = Binding.Service<ListDistributions>(
  "Stackit.CDN.ListDistributions",
);
