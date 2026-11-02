import type * as cdn from "@distilled.cloud/stackit/cdn";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CustomDomain } from "./CustomDomain.ts";

export interface GetCustomDomainRequest extends Omit<
  cdn.GetCustomDomainRequest,
  "projectId" | "distributionId" | "domain"
> {}

/**
 * Runtime binding for CDN `GetCustomDomain`: read a custom domain's status and certificate kind.
 *
 * Bind this operation to a {@link CustomDomain} in a Function/Worker init phase and provide
 * {@link GetCustomDomainHttp}. The resource's project, distribution and domain are injected into each request. It
 * works on any host. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role holding only `cdn.distribution.get` on the project holding
 * the custom domain, so it reaches every custom domain in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single custom
 * domain. The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Custom Domain
 * **Example:** Report status from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Www = Stackit.CDN.CustomDomain("WwwDomain", {
 *   distributionId: "11111111-1111-4111-8111-111111111111",
 *   domain: "www.example.com",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getCustomDomain = yield* Stackit.CDN.GetCustomDomain(yield* Www);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { customDomain } = yield* getCustomDomain();
 *         return yield* HttpServerResponse.json({ status: customDomain.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CDN.GetCustomDomainHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT CDN
 * @category CDN
 */
export interface GetCustomDomain extends Binding.Service<
  GetCustomDomain,
  "Stackit.CDN.GetCustomDomain",
  (
    customDomain: CustomDomain,
  ) => Effect.Effect<
    (
      request?: GetCustomDomainRequest,
    ) => Effect.Effect<cdn.GetCustomDomainResponse, cdn.GetCustomDomainError, RuntimeContext>
  >
> {}

export const GetCustomDomain = Binding.Service<GetCustomDomain>("Stackit.CDN.GetCustomDomain");
