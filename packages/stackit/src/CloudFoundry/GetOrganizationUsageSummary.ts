import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface GetOrganizationUsageSummaryRequest extends Omit<
  scf.GetOrganizationUsageSummaryRequest,
  "projectId" | "region" | "organizationId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `getOrganizationUsageSummary`: read the bound organization's usage: memory, instances, routes and services.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link GetOrganizationUsageSummaryHttp}. The organization's project, region and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.org.usage.get`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### Get Organization Usage Summary
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
 *     const getUsage = yield* Stackit.CloudFoundry.GetOrganizationUsageSummary(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const usage = yield* getUsage();
 *         return yield* HttpServerResponse.json({ memoryInMb: usage.usageSummary.memoryInMb });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.GetOrganizationUsageSummaryHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface GetOrganizationUsageSummary extends Binding.Service<
  GetOrganizationUsageSummary,
  "Stackit.CloudFoundry.GetOrganizationUsageSummary",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request?: GetOrganizationUsageSummaryRequest,
    ) => Effect.Effect<
      scf.OrganizationUsageSummary,
      scf.GetOrganizationUsageSummaryError,
      RuntimeContext
    >
  >
> {}

export const GetOrganizationUsageSummary = Binding.Service<GetOrganizationUsageSummary>(
  "Stackit.CloudFoundry.GetOrganizationUsageSummary",
);
