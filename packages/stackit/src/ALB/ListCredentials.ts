import type * as alb from "@distilled.cloud/stackit/alb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "../LoadBalancer/BindingScope.ts";

/**
 * Runtime binding for Application Load Balancer `ListCredentials`: list the
 * observability credentials of a project and region. STACKIT never returns
 * their passwords.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link ListCredentialsHttp}. It works on any host. A foreign host signs with
 * a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `alb.credentials.list` on the project of
 * the bound resource, the narrowest scope STACKIT binds roles on, so it
 * reaches that whole project. The deployer needs `iam.role.add` on that scope
 * to define the role.
 *
 * ### Listing Credentials
 * **Example:** List credential names from a Cloudflare Worker
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
 *     const listCredentials = yield* Stackit.ALB.ListCredentials(yield* Network);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { credentials } = yield* listCredentials();
 *         return yield* HttpServerResponse.json({
 *           names: (credentials ?? []).map((credential) => credential.displayName),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ALB.ListCredentialsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Application Load Balancer
 * @category ALB
 */
export interface ListCredentials extends Binding.Service<
  ListCredentials,
  "Stackit.ALB.ListCredentials",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    () => Effect.Effect<alb.ListCredentialsResponse, alb.ListCredentialsError, RuntimeContext>
  >
> {}

export const ListCredentials = Binding.Service<ListCredentials>("Stackit.ALB.ListCredentials");
