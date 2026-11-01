import type * as forgejo from "@distilled.cloud/stackit/git_forgejo";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface GetRepositoryRequest extends Omit<
  forgejo.GetRepositoryRequest,
  "owner" | "repo"
> {}

/**
 * Runtime binding for Forgejo's `repoGet`: read a repository's branch, visibility and clone URLs from
 * the instance's REST API.
 *
 * Bind this operation to a {@link Repository} in a Function/Worker init phase and provide
 * {@link GetRepositoryHttp}. The instance's URL and the repository's owner and name are injected into
 * each request.
 *
 * Access: Forgejo takes no STACKIT identity, so the host gets **the login the repository resource
 * manages it with**, as `Redacted` env values. It can do whatever that login can, not just read
 * this repository, so give a repository a host binds a token with narrow scopes. The instance's
 * `acl` has to let the host's egress address in.
 *
 * ### Reading the Repository
 * **Example:** Report whether a repository has commits, from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * // A Worker has no stable egress address.
 * export const Forge = Stackit.Git.Instance("Forge", { acl: ["0.0.0.0/0"] });
 * export const App = Effect.gen(function* () {
 *   const forge = yield* Forge;
 *   const token = yield* Config.redacted("FORGE_READ_TOKEN");
 *   return yield* Stackit.Git.Repository("App", { instanceUrl: forge.url, token });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getRepository = yield* Stackit.Git.GetRepository(yield* App);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const repository = yield* getRepository({});
 *         return yield* HttpServerResponse.json({ empty: repository.empty });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.GetRepositoryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface GetRepository extends Binding.Service<
  GetRepository,
  "Stackit.Git.GetRepository",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: GetRepositoryRequest,
    ) => Effect.Effect<forgejo.Repository, forgejo.GetRepositoryError, RuntimeContext>
  >
> {}

export const GetRepository = Binding.Service<GetRepository>("Stackit.Git.GetRepository");
