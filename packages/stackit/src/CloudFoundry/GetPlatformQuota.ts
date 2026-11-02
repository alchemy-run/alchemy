import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface GetPlatformQuotaRequest extends Omit<
  scf.GetPlatformQuotaRequest,
  "projectId" | "region" | "platformId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `getPlatformQuota`: read a quota plan of the platform the bound organization is on.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link GetPlatformQuotaHttp}. The organization's project, region and platform are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.platform.quota.get`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### Get Platform Quota
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
 *     const getQuota = yield* Stackit.CloudFoundry.GetPlatformQuota(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const quota = yield* getQuota({ quotaId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ name: quota.name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.GetPlatformQuotaHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface GetPlatformQuota extends Binding.Service<
  GetPlatformQuota,
  "Stackit.CloudFoundry.GetPlatformQuota",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request: GetPlatformQuotaRequest,
    ) => Effect.Effect<scf.Quota, scf.GetPlatformQuotaError, RuntimeContext>
  >
> {}

export const GetPlatformQuota = Binding.Service<GetPlatformQuota>(
  "Stackit.CloudFoundry.GetPlatformQuota",
);
