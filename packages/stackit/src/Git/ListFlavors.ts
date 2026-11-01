import type * as git from "@distilled.cloud/stackit/git";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

export interface ListFlavorsRequest extends Omit<git.ListFlavorsRequest, "projectId"> {}

/**
 * Runtime binding for STACKIT Git `listFlavors`: list the plans instances can be created with.
 *
 * Bind this operation to any resource with a `projectId` attribute, such as a
 * `Stackit.Git.Instance` or a `Stackit.ResourceManager.Project`, in a Function/Worker init phase
 * and provide {@link ListFlavorsHttp}. The project of the resource it binds to is injected into each request.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `git.instance.create`, the permission the spec names for this operation, on
 * the project holding the instance, because STACKIT binds roles on nothing narrower than a project.
 * It reaches every instance in that project. Note how broad this one is: it also lets the host create instances, which
 * are billed.
 *
 * ### Listing Plans
 * **Example:** List the plans from a Cloudflare Worker
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
 *     const listFlavors = yield* Stackit.Git.ListFlavors(yield* Forge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { flavors } = yield* listFlavors({});
 *         return yield* HttpServerResponse.json({ ids: flavors.map((flavor) => flavor.id) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Git.ListFlavorsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Git
 * @category Git
 */
export interface ListFlavors extends Binding.Service<
  ListFlavors,
  "Stackit.Git.ListFlavors",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request: ListFlavorsRequest,
    ) => Effect.Effect<git.FlavorList, git.ListFlavorsError, RuntimeContext>
  >
> {}

export const ListFlavors = Binding.Service<ListFlavors>("Stackit.Git.ListFlavors");
