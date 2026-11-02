import type * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ServiceAccount } from "./ServiceAccount.ts";

/**
 * Runtime binding for the Service Account API's `ListServiceAccountKeys`: the
 * id, algorithm, state and expiry of a service account's keys, for rotation
 * and expiry checks. It never returns private keys.
 *
 * Bind this operation to a {@link ServiceAccount} in a Function/Worker init
 * phase and provide {@link ListServiceAccountKeysHttp}. It works on any host.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `iam.service-account-key.list` on the
 * project holding the account, so it lists the keys of every service account
 * in that project: Alchemy binds roles on projects, not single accounts. The
 * deployer needs `iam.role.add` on that scope to define the role.
 *
 * ### Listing a Service Account's Keys
 * **Example:** Find keys that are about to expire
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ci = Stackit.IAM.ServiceAccount("Ci", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listKeys = yield* Stackit.IAM.ListServiceAccountKeys(yield* Ci);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listKeys();
 *         return yield* HttpServerResponse.json({ expiries: items.map((key) => key.validUntil) });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.IAM.ListServiceAccountKeysHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Service Account
 * @category IAM
 */
export interface ListServiceAccountKeys extends Binding.Service<
  ListServiceAccountKeys,
  "Stackit.IAM.ListServiceAccountKeys",
  (
    account: ServiceAccount,
  ) => Effect.Effect<
    () => Effect.Effect<
      serviceAccount.ListServiceAccountKeysResponse,
      serviceAccount.ListServiceAccountKeysError,
      RuntimeContext
    >
  >
> {}

export const ListServiceAccountKeys = Binding.Service<ListServiceAccountKeys>(
  "Stackit.IAM.ListServiceAccountKeys",
);
