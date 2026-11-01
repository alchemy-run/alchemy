import type * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

/**
 * Runtime binding for Resource Manager `GetOrganization`: read an
 * organization's name, labels and lifecycle state.
 *
 * Bind this operation to an {@link Organization}, or an organization id as a
 * string or Output, in a Function/Worker init phase and provide {@link
 * GetOrganizationHttp}. `folder.parentId` is the id for a top-level folder.
 * Prefer the id unless you manage the organization: deploying an
 * `Organization` writes Alchemy's labels on it. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the organization holding only
 * `resource-manager.organization.get`. The smallest predefined role covering
 * it is the general `reader`, which reads every service in the organization.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading an Organization
 * **Example:** Read the organization holding a folder
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Team = Stackit.ResourceManager.Folder("Team", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const team = yield* Team;
 *     const getOrganization = yield* Stackit.ResourceManager.GetOrganization(team.parentId);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const organization = yield* getOrganization();
 *         return yield* HttpServerResponse.json({ name: organization.name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ResourceManager.GetOrganizationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Resource Manager
 * @category ResourceManager
 */
export interface GetOrganization extends Binding.Service<
  GetOrganization,
  "Stackit.ResourceManager.GetOrganization",
  (
    organization: Organization | string,
  ) => Effect.Effect<
    () => Effect.Effect<
      resourceManager.OrganizationResponse,
      resourceManager.GetOrganizationError,
      RuntimeContext
    >
  >
> {}

export const GetOrganization = Binding.Service<GetOrganization>(
  "Stackit.ResourceManager.GetOrganization",
);
