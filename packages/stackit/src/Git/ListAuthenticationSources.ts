import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAuthenticationSourcesRequest extends Omit<
  git.ListAuthenticationRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Git `listAuthentication`: list an instance's OIDC sign-in sources.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link ListAuthenticationSourcesHttp}. The instance's project and id are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.authentication-source.list`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Listing Sources
 * **Example:** List the sources from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Forge = Stackit.Git.Instance("Forge", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listAuthenticationSources = yield* Stackit.Git.ListAuthenticationSources(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { authentication } = yield* listAuthenticationSources({});
 *         return yield* HttpServerResponse.json({ names: authentication.map((source) => source.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.ListAuthenticationSourcesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface ListAuthenticationSources extends Binding.Service<
  ListAuthenticationSources,
  "Stackit.Git.ListAuthenticationSources",
  (
    forge: Instance,
  ) => Effect.Effect<
    (
      request: ListAuthenticationSourcesRequest,
    ) => Effect.Effect<git.AuthenticationList, git.ListAuthenticationError, RuntimeContext>
  >
> {}

export const ListAuthenticationSources = Binding.Service<ListAuthenticationSources>(
  "Stackit.Git.ListAuthenticationSources",
);
