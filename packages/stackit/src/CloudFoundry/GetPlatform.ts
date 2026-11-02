import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface GetPlatformRequest extends Omit<
  scf.GetPlatformRequest,
  "projectId" | "region" | "platformId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `getPlatform`: read the platform the bound organization is on, for its `apiUrl` and `consoleUrl`.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link GetPlatformHttp}. The organization's project, region and platform are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.platform.get`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### Get Platform
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
 *     const getPlatform = yield* Stackit.CloudFoundry.GetPlatform(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const platform = yield* getPlatform();
 *         return yield* HttpServerResponse.json({ apiUrl: platform.apiUrl });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.GetPlatformHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface GetPlatform extends Binding.Service<
  GetPlatform,
  "Stackit.CloudFoundry.GetPlatform",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request?: GetPlatformRequest,
    ) => Effect.Effect<scf.Platforms, scf.GetPlatformError, RuntimeContext>
  >
> {}

export const GetPlatform = Binding.Service<GetPlatform>("Stackit.CloudFoundry.GetPlatform");
