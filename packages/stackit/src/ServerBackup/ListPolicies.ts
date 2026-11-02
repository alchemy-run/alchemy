import type * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

export interface ListPoliciesRequest extends Omit<
  serverBackup.ListBackupPoliciesRequest,
  "projectId"
> {}

/**
 * Runtime binding for Server Backup `listBackupPolicies`: list the backup policies a
 * project can use, whose ids `Stackit.ServerBackup.Enablement` takes.
 *
 * Bind this operation to any resource in that project (a {@link BindingScope}) in a
 * Function/Worker init phase and provide {@link ListPoliciesHttp}. Its project is
 * injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `server-backup.policy.list` on the project of the
 * bound resource, so it reaches that whole project: STACKIT binds roles on projects,
 * folders and organizations, not on a single server. The deployer needs `iam.role.add`
 * on that scope to define the role.
 *
 * ### Listing Policies
 * **Example:** List the project's backup policies
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Network = Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listPolicies = yield* Stackit.ServerBackup.ListPolicies(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listPolicies();
 *         return yield* HttpServerResponse.json({ policies: items?.map((policy) => policy.id) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ServerBackup.ListPoliciesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export interface ListPolicies extends Binding.Service<
  ListPolicies,
  "Stackit.ServerBackup.ListPolicies",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListPoliciesRequest,
    ) => Effect.Effect<
      serverBackup.GetBackupPoliciesResponse,
      serverBackup.ListBackupPoliciesError,
      RuntimeContext
    >
  >
> {}

export const ListPolicies = Binding.Service<ListPolicies>("Stackit.ServerBackup.ListPolicies");
