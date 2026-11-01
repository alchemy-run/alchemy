import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface GetOrganizationRequest extends Omit<
  scf.GetOrganizationRequest,
  "projectId" | "region" | "organizationId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `getOrganization`: read the bound organization.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link GetOrganizationHttp}. The organization's project, region and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.org.get`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### Get Organization
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
 *     const getOrganization = yield* Stackit.CloudFoundry.GetOrganization(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const organization = yield* getOrganization();
 *         return yield* HttpServerResponse.json({ status: organization.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.GetOrganizationHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface GetOrganization extends Binding.Service<
  GetOrganization,
  "Stackit.CloudFoundry.GetOrganization",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request?: GetOrganizationRequest,
    ) => Effect.Effect<scf.Organization, scf.GetOrganizationError, RuntimeContext>
  >
> {}

export const GetOrganization = Binding.Service<GetOrganization>(
  "Stackit.CloudFoundry.GetOrganization",
);
