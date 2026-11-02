import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateAccessTokenRequest extends Omit<
  logs.CreateAccessTokenRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for Logs `createAccessToken`: mint a scoped token for a tenant or an
 * agent. `accessToken` on the result is `Redacted`, and it is the only time STACKIT
 * returns the value. Delete a token you minted with `Stackit.Logs.DeleteAccessToken`,
 * or give it a `lifetime`: Alchemy doesn't track it.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CreateAccessTokenHttp}. A foreign host signs with a service account
 * key Alchemy creates for it.
 *
 * Access: a custom role holding only `logs.instance.credentials.create`, on the
 * project holding the instance. STACKIT binds roles on projects, folders and
 * organizations, never on one instance, so the role reaches every Logs instance in the
 * project. The deployer needs `iam.role.add` on the project to define it.
 *
 * ### Minting a Token
 * **Example:** Mint a short-lived token from a Cloudflare Worker
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
 *     const createAccessToken = yield* Stackit.Logs.CreateAccessToken(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* createAccessToken({
 *           displayName: "tenant-a",
 *           permissions: ["write"],
 *           lifetime: 1,
 *         });
 *         return yield* HttpServerResponse.json({ id: result.id, validUntil: result.validUntil });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.CreateAccessTokenHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface CreateAccessToken extends Binding.Service<
  CreateAccessToken,
  "Stackit.Logs.CreateAccessToken",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateAccessTokenRequest,
    ) => Effect.Effect<logs.AccessToken, logs.CreateAccessTokenError, RuntimeContext>
  >
> {}

export const CreateAccessToken = Binding.Service<CreateAccessToken>(
  "Stackit.Logs.CreateAccessToken",
);
