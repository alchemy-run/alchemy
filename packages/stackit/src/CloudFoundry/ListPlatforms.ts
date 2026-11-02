import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface ListPlatformsRequest extends Omit<
  scf.ListPlatformsRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `listPlatforms`: list the platforms available in the bound organization's project and region.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link ListPlatformsHttp}. The organization's project and region are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.platform.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### List Platforms
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
 *     const listPlatforms = yield* Stackit.CloudFoundry.ListPlatforms(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const listed = yield* listPlatforms();
 *         return yield* HttpServerResponse.json({ names: listed.resources.map((platform) => platform.displayName) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.ListPlatformsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface ListPlatforms extends Binding.Service<
  ListPlatforms,
  "Stackit.CloudFoundry.ListPlatforms",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request?: ListPlatformsRequest,
    ) => Effect.Effect<scf.PlatformList, scf.ListPlatformsError, RuntimeContext>
  >
> {}

export const ListPlatforms = Binding.Service<ListPlatforms>("Stackit.CloudFoundry.ListPlatforms");
