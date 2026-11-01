import type * as scf from "@distilled.cloud/stackit/scf";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "./Organization.ts";

export interface ListSpacesRequest extends Omit<
  scf.ListSpacesRequest,
  "projectId" | "region" | "organizationId"
> {}

/**
 * Runtime binding for STACKIT Cloud Foundry's `listSpaces`: list the spaces in the bound organization.
 *
 * Bind this operation to a {@link Organization} in a Function/Worker init phase and provide
 * {@link ListSpacesHttp}. The organization's project, region and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `scf.space.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every organization in the
 * project.
 *
 * ### List Spaces
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
 *     const listSpaces = yield* Stackit.CloudFoundry.ListSpaces(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const listed = yield* listSpaces();
 *         return yield* HttpServerResponse.json({ names: listed.resources.map((space) => space.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.ListSpacesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category CloudFoundry
 */
export interface ListSpaces extends Binding.Service<
  ListSpaces,
  "Stackit.CloudFoundry.ListSpaces",
  (
    organization: Organization,
  ) => Effect.Effect<
    (
      request?: ListSpacesRequest,
    ) => Effect.Effect<scf.SpacesList, scf.ListSpacesError, RuntimeContext>
  >
> {}

export const ListSpaces = Binding.Service<ListSpaces>("Stackit.CloudFoundry.ListSpaces");
