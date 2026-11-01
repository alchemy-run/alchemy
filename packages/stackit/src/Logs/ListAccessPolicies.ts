import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAccessPoliciesRequest extends Omit<
  logs.ListAccessPoliciesRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for Logs `listAccessPolicies`: list the instance's access policies,
 * for an audit. The API returns the whole list.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListAccessPoliciesHttp}. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: a custom role holding only `logs.instance.access-policies.list`, on the
 * project holding the instance. STACKIT binds roles on projects, folders and
 * organizations, never on one instance, so the role reaches every Logs instance in the
 * project. The deployer needs `iam.role.add` on the project to define it.
 *
 * ### Listing Policies
 * **Example:** List who has access from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listAccessPolicies = yield* Stackit.Logs.ListAccessPolicies(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* listAccessPolicies({});
 *         return yield* HttpServerResponse.json({ emails: result.policies.map((policy) => policy.email) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.ListAccessPoliciesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface ListAccessPolicies extends Binding.Service<
  ListAccessPolicies,
  "Stackit.Logs.ListAccessPolicies",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListAccessPoliciesRequest,
    ) => Effect.Effect<logs.AccessPolicyList, logs.ListAccessPoliciesError, RuntimeContext>
  >
> {}

export const ListAccessPolicies = Binding.Service<ListAccessPolicies>(
  "Stackit.Logs.ListAccessPolicies",
);
