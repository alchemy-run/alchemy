import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface ListOrganizationsRequest extends Omit<
  scf.ListOrganizationsRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `listOrganizations`: list the organizations in the same project and region as the bound one.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link ListOrganizationsHttp}. The organization's project and region are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.org.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### List Organizations
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Org = Stackit.CloudFoundry.Organization("Org", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const organization = yield* Org;
 *     const listOrganizations = yield* Stackit.CloudFoundry.ListOrganizations(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const listed = yield* listOrganizations();
 *         return yield* HttpServerResponse.json({ names: listed.resources.map((organization) => organization.guid) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.ListOrganizationsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface ListOrganizations extends Binding.Service<
  ListOrganizations,
  "Stackit.CloudFoundry.ListOrganizations",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request?: ListOrganizationsRequest,
    ) => Effect.Effect<scf.OrganizationsList, scf.ListOrganizationsError, RuntimeContext>
  >
> {}

export const ListOrganizations = Binding.Service<ListOrganizations>(
  "Stackit.CloudFoundry.ListOrganizations",
);
