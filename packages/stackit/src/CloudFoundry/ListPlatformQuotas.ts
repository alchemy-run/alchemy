import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface ListPlatformQuotasRequest extends Omit<
  scf.ListPlatformQuotasRequest,
  "projectId" | "region" | "platformId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `listPlatformQuotas`: list the quota plans of the platform the bound organization is on.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link ListPlatformQuotasHttp}. The organization's project, region and platform are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.platform.quota.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### List Platform Quotas
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
 *     const listQuotas = yield* Stackit.CloudFoundry.ListPlatformQuotas(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const quotas = yield* listQuotas();
 *         return yield* HttpServerResponse.json({ names: quotas.map((quota) => quota.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.ListPlatformQuotasHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface ListPlatformQuotas extends Binding.Service<
  ListPlatformQuotas,
  "Stackit.CloudFoundry.ListPlatformQuotas",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request?: ListPlatformQuotasRequest,
    ) => Effect.Effect<scf.ListPlatformQuotasResponse, scf.ListPlatformQuotasError, RuntimeContext>
  >
> {}

export const ListPlatformQuotas = Binding.Service<ListPlatformQuotas>(
  "Stackit.CloudFoundry.ListPlatformQuotas",
);
