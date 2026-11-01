import type * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface ListOrganizationsRequest extends resourceManager.ListOrganizationsRequest {}

/**
 * Runtime binding for Resource Manager `ListOrganizations`: the organizations
 * the host's identity can see. The call isn't scoped to the bound
 * organization, but a created service account sees only the organizations it
 * holds a role on, which is this one unless you grant more.
 *
 * Bind this operation to an {@link Organization}, or an organization id as a
 * string or Output, in a Function/Worker init phase and provide {@link
 * ListOrganizationsHttp}. `folder.parentId` is the id for a top-level folder.
 * Prefer the id unless you manage the organization: deploying an
 * `Organization` writes Alchemy's labels on it. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role on the organization holding
 * `resource-manager.organization.list` and
 * `resource-manager.organization.get`, since STACKIT evaluates either
 * depending on whether the request filters by `containerIds`. The smallest
 * predefined role covering them is the general `reader`, which reads every
 * service in the organization. The deployer needs `iam.role.add` on that scope
 * to define the role.
 *
 * ### Listing Organizations
 * **Example:** List the organizations the Worker can see
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
 *     const listOrganizations = yield* Stackit.ResourceManager.ListOrganizations(team.parentId);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listOrganizations();
 *         return yield* HttpServerResponse.json({ organizations: items.map(({ name }) => name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ResourceManager.ListOrganizationsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Resource Manager
 * @category ResourceManager
 */
export interface ListOrganizations extends Binding.Service<
  ListOrganizations,
  "Stackit.ResourceManager.ListOrganizations",
  (
    organization: Organization | string,
  ) => Effect.Effect<
    (
      request?: ListOrganizationsRequest,
    ) => Effect.Effect<
      resourceManager.ListOrganizationsResponse,
      resourceManager.ListOrganizationsError,
      RuntimeContext
    >
  >
> {}

export const ListOrganizations = Binding.Service<ListOrganizations>(
  "Stackit.ResourceManager.ListOrganizations",
);
