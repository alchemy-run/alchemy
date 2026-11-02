import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Space } from "./Space.ts";

export interface GetSpaceRequest extends Omit<
  scf.GetSpaceRequest,
  "projectId" | "region" | "organizationId" | "spaceId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `getSpace`: read the bound space.
 *
 * Bind this operation to a {@link Space} in a Function/Worker init phase and provide
 * {@link GetSpaceHttp}. The space's project, region, organization and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.space.get`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### Get Space
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Org = Stackit.CloudFoundry.Organization("Org", {});
 * export const Dev = Effect.gen(function* () {
 *   const organization = yield* Org;
 *   return yield* Stackit.CloudFoundry.Space("Dev", {
 *     organizationId: organization.organizationId,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const space = yield* Dev;
 *     const getSpace = yield* Stackit.CloudFoundry.GetSpace(space);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const space = yield* getSpace();
 *         return yield* HttpServerResponse.json({ name: space.name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.GetSpaceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface GetSpace extends Binding.Service<
  GetSpace,
  "Stackit.CloudFoundry.GetSpace",
  (
    space: Space,
  ) => Effect.Effect<
    (request?: GetSpaceRequest) => Effect.Effect<scf.Space, scf.GetSpaceError, RuntimeContext>
  >
> {}

export const GetSpace = Binding.Service<GetSpace>("Stackit.CloudFoundry.GetSpace");
