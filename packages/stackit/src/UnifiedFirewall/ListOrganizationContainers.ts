import type * as ufw from "@distilled.cloud/stackit/ufw";
import * as Binding from "alchemy/Binding";
import type * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Organization } from "../ResourceManager/Organization.ts";

export interface ListOrganizationContainersRequest extends Omit<
  ufw.ListOrganizationContainersRequest,
  "organizationId"
> {}

/**
 * Runtime binding for Unified Firewall `listOrganizationContainers`: list the containers inside an
 * organization, one page at a time.
 *
 * Bind this operation to an {@link Organization}, or an organization's UUID as a string or Output,
 * in a Function/Worker init phase and provide {@link ListOrganizationContainersHttp}. The
 * organization's id is injected into each request. It works on any host. A foreign host signs with
 * a service account key Alchemy creates for it.
 *
 * Access: a custom role on the organization holding only `ufw.organization.list`. The role is
 * inherited by everything in the organization. The deployer needs `iam.role.add` on the
 * organization to define the role.
 *
 * ### Listing an Organization
 * **Example:** List what's inside an organization
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listContainers = yield* Stackit.UnifiedFirewall.ListOrganizationContainers(
 *       "00000000-0000-0000-0000-000000000000",
 *     );
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listContainers({ limit: 100 });
 *         return yield* HttpServerResponse.json({ names: items.map((item) => item.name) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.UnifiedFirewall.ListOrganizationContainersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Unified Firewall
 * @category UnifiedFirewall
 */
export interface ListOrganizationContainers extends Binding.Service<
  ListOrganizationContainers,
  "Stackit.UnifiedFirewall.ListOrganizationContainers",
  (
    organization: Organization | string | Output.Output<string, never>,
  ) => Effect.Effect<
    (
      request?: ListOrganizationContainersRequest,
    ) => Effect.Effect<
      ufw.ListContainersResponse,
      ufw.ListOrganizationContainersError,
      RuntimeContext
    >
  >
> {}

export const ListOrganizationContainers = Binding.Service<ListOrganizationContainers>(
  "Stackit.UnifiedFirewall.ListOrganizationContainers",
);
