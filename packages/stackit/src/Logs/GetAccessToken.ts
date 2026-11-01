import type * as logs from "@distilled.cloud/stackit/logs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetAccessTokenRequest extends Omit<
  logs.GetAccessTokenRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for Logs `getAccessToken`: read a token's status and expiry by its
 * id. The value isn't returned.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetAccessTokenHttp}. A foreign host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding only `logs.instance.credentials.get`, on the project
 * holding the instance. STACKIT binds roles on projects, folders and organizations,
 * never on one instance, so the role reaches every Logs instance in the project. The
 * deployer needs `iam.role.add` on the project to define it.
 *
 * ### Reading a Token
 * **Example:** Check a token's expiry from a Cloudflare Worker
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
 *     const getAccessToken = yield* Stackit.Logs.GetAccessToken(yield* Logs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getAccessToken({ tId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ status: result.status, validUntil: result.validUntil });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.GetAccessTokenHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface GetAccessToken extends Binding.Service<
  GetAccessToken,
  "Stackit.Logs.GetAccessToken",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetAccessTokenRequest,
    ) => Effect.Effect<logs.AccessToken, logs.GetAccessTokenError, RuntimeContext>
  >
> {}

export const GetAccessToken = Binding.Service<GetAccessToken>("Stackit.Logs.GetAccessToken");
