import type * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

/**
 * Runtime binding for Load Balancer `ListCredentials`: list the observability
 * credentials in a project and region. STACKIT never returns their passwords.
 *
 * Bind this operation to any resource in that project and region (a
 * {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link ListCredentialsHttp}. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `nlb.credentials.list` on the project of the
 * bound resource. STACKIT binds roles on projects, folders and organizations, and
 * this operation lists the whole project. The deployer needs `iam.role.add` on
 * that scope to define the role.
 *
 * ### Listing Credentials
 * **Example:** List a project's credentials from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Metrics = Stackit.LoadBalancer.ObservabilityCredential("Metrics", {
 *   username: "metrics-writer",
 *   password: Redacted.make("change-me"),
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listCredentials = yield* Stackit.LoadBalancer.ListCredentials(yield* Metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { credentials } = yield* listCredentials();
 *         return yield* HttpServerResponse.json({
 *           names: (credentials ?? []).map((credential) => credential.displayName),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LoadBalancer.ListCredentialsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Network Load Balancer
 * @category LoadBalancer
 */
export interface ListCredentials extends Binding.Service<
  ListCredentials,
  "Stackit.LoadBalancer.ListCredentials",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    () => Effect.Effect<lb.ListCredentialsResponse, lb.ListCredentialsError, RuntimeContext>
  >
> {}

export const ListCredentials = Binding.Service<ListCredentials>(
  "Stackit.LoadBalancer.ListCredentials",
);
