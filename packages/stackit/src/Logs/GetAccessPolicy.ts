import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetAccessPolicyRequest extends Omit<
  logs.GetAccessPolicyRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for Logs `getAccessPolicy`: read an access policy by its id.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and provide
 * {@link GetAccessPolicyHttp}. A foreign host signs with a service account key Alchemy
 * creates
 * for it.
 *
 * Access: a custom role holding only `logs.instance.access-policies.get`, on the project
 * holding the instance.
 * STACKIT binds roles on projects, folders and organizations, never on one instance, so
 * the role reaches every Logs instance in the project. The deployer needs `iam.role.add`
 * on the project to define it.
 *
 * ### Reading a Policy
 * **Example:** Read a policy from a Cloudflare Worker
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
 *     const getAccessPolicy = yield* Stackit.Logs.GetAccessPolicy(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getAccessPolicy({ pId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ email: result.email, permissions: result.permissions });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.GetAccessPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface GetAccessPolicy extends Binding.Service<
  GetAccessPolicy,
  "Stackit.Logs.GetAccessPolicy",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetAccessPolicyRequest,
    ) => Effect.Effect<logs.AccessPolicy, logs.GetAccessPolicyError, RuntimeContext>
  >
> {}

export const GetAccessPolicy = Binding.Service<GetAccessPolicy>("Stackit.Logs.GetAccessPolicy");
