import type * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ServiceAccount } from "./ServiceAccount.ts";

/**
 * Runtime binding for the Service Account API's `GetJWKS`: the public JSON Web
 * Key set of a service account, for verifying JWTs signed with its keys.
 *
 * Bind this operation to a {@link ServiceAccount} in a Function/Worker init
 * phase and provide {@link GetJWKSHttp}. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: none. STACKIT serves the key set publicly, so the binding grants no
 * role; the created service account only needs to authenticate.
 *
 * ### Reading a Service Account's Public Keys
 * **Example:** Fetch the key set to verify a token
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Signer = Stackit.IAM.ServiceAccount("Signer", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getJWKS = yield* Stackit.IAM.GetJWKS(yield* Signer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { keys } = yield* getJWKS();
 *         return yield* HttpServerResponse.json({ keys });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IAM.GetJWKSHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Service Account
 * @category IAM
 */
export interface GetJWKS extends Binding.Service<
  GetJWKS,
  "Stackit.IAM.GetJWKS",
  (
    account: ServiceAccount,
  ) => Effect.Effect<
    () => Effect.Effect<serviceAccount.JWKS, serviceAccount.GetJWKSError, RuntimeContext>
  >
> {}

export const GetJWKS = Binding.Service<GetJWKS>("Stackit.IAM.GetJWKS");
