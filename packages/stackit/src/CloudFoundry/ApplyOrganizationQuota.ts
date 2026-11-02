import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface ApplyOrganizationQuotaRequest extends Omit<
  scf.ApplyOrganizationQuotaRequest,
  "projectId" | "region" | "organizationId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `applyOrganizationQuota`: change the bound organization's quota, for scaling a tenant at runtime.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link ApplyOrganizationQuotaHttp}. The organization's project, region and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.org.quota.update`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### Apply Organization Quota
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
 *     const applyQuota = yield* Stackit.CloudFoundry.ApplyOrganizationQuota(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const applied = yield* applyQuota({ quotaId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ quotaId: applied.quotaId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.ApplyOrganizationQuotaHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface ApplyOrganizationQuota extends Binding.Service<
  ApplyOrganizationQuota,
  "Stackit.CloudFoundry.ApplyOrganizationQuota",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request: ApplyOrganizationQuotaRequest,
    ) => Effect.Effect<scf.OrganizationQuota, scf.ApplyOrganizationQuotaError, RuntimeContext>
  >
> {}

export const ApplyOrganizationQuota = Binding.Service<ApplyOrganizationQuota>(
  "Stackit.CloudFoundry.ApplyOrganizationQuota",
);
