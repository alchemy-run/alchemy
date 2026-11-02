import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface ListOrganizationQuotasRequest extends Omit<
  scf.ListOrganizationQuotasRequest,
  "projectId" | "region" | "organizationId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `listOrganizationQuotas`: list the quotas applicable to the bound organization.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link ListOrganizationQuotasHttp}. The organization's project, region and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.org.quota.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### List Organization Quotas
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
 *     const listQuotas = yield* Stackit.CloudFoundry.ListOrganizationQuotas(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const quotas = yield* listQuotas();
 *         return yield* HttpServerResponse.json({ names: quotas.map((quota) => quota.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.ListOrganizationQuotasHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface ListOrganizationQuotas extends Binding.Service<
  ListOrganizationQuotas,
  "Stackit.CloudFoundry.ListOrganizationQuotas",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request?: ListOrganizationQuotasRequest,
    ) => Effect.Effect<
      scf.ListOrganizationQuotasResponse,
      scf.ListOrganizationQuotasError,
      RuntimeContext
    >
  >
> {}

export const ListOrganizationQuotas = Binding.Service<ListOrganizationQuotas>(
  "Stackit.CloudFoundry.ListOrganizationQuotas",
);
