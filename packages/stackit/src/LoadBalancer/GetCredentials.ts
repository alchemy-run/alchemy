import type * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ObservabilityCredential } from "./ObservabilityCredential.ts";

/**
 * Runtime binding for Load Balancer `GetCredentials`: read an observability
 * credential's display name and username. STACKIT never returns its password.
 *
 * Bind this operation to an {@link ObservabilityCredential} in a Function/Worker
 * init phase and provide {@link GetCredentialsHttp}. The credential's project,
 * region and reference are injected into each request. It works on any host. A
 * foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `nlb.credentials.get` on the project holding
 * the credential, so it reaches every credential in that project: STACKIT binds
 * roles on projects, folders and organizations, not on a single credential. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Reading a Credential
 * **Example:** Read the credential's username from a Cloudflare Worker
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
 *     const getCredentials = yield* Stackit.LoadBalancer.GetCredentials(yield* Metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { credential } = yield* getCredentials();
 *         return yield* HttpServerResponse.json({ username: credential?.username });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LoadBalancer.GetCredentialsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Network Load Balancer
 * @category LoadBalancer
 */
export interface GetCredentials extends Binding.Service<
  GetCredentials,
  "Stackit.LoadBalancer.GetCredentials",
  (
    credential: ObservabilityCredential,
  ) => Effect.Effect<
    () => Effect.Effect<lb.GetCredentialsResponse, lb.GetCredentialsError, RuntimeContext>
  >
> {}

export const GetCredentials = Binding.Service<GetCredentials>(
  "Stackit.LoadBalancer.GetCredentials",
);
