import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetAuthenticationSourceRequest extends Omit<
  git.GetAuthenticationRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Git `getAuthentication`: read an OIDC sign-in source on an instance. The client secret isn't returned.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase
 * and provide {@link GetAuthenticationSourceHttp}. The instance's project and id are injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.authentication-source.get`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project.
 *
 * ### Reading a Source
 * **Example:** Report a source's status from a Cloudflare Worker
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
 *     const getAuthenticationSource = yield* Stackit.Git.GetAuthenticationSource(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const source = yield* getAuthenticationSource({ authenticationId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ status: source.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.GetAuthenticationSourceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface GetAuthenticationSource extends Binding.Service<
  GetAuthenticationSource,
  "Stackit.Git.GetAuthenticationSource",
  (
    forge: Instance,
  ) => Effect.Effect<
    (
      request: GetAuthenticationSourceRequest,
    ) => Effect.Effect<git.Authentication, git.GetAuthenticationError, RuntimeContext>
  >
> {}

export const GetAuthenticationSource = Binding.Service<GetAuthenticationSource>(
  "Stackit.Git.GetAuthenticationSource",
);
