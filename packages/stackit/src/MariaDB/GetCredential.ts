import type * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetCredentialRequest extends Omit<
  mariadb.GetCredentialsRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT MariaDB `getCredentials`: read a credential of the instance by id, with its connection details.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetCredentialHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `mariadb.credential.get`, bound on the project
 * holding the instance. STACKIT binds roles on projects at the narrowest, so the
 * permission reaches every MariaDB instance in that project.
 *
 * ### Calling `getCredentials`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Db = Stackit.MariaDB.Instance("Db", {
 *   version: "10.11",
 *   planName: "stackit-mariadb-1.2.10-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const instance = yield* Db;
 *     const getCredential = yield* Stackit.MariaDB.GetCredential(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const credential = yield* getCredential({ credentialsId: "a-credential-id" });
 *         return yield* HttpServerResponse.json({ id: credential.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.MariaDB.GetCredentialHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category MariaDB
 */
export interface GetCredential extends Binding.Service<
  GetCredential,
  "Stackit.MariaDB.GetCredential",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetCredentialRequest,
    ) => Effect.Effect<mariadb.CredentialsResponse, mariadb.GetCredentialsError, RuntimeContext>
  >
> {}

export const GetCredential = Binding.Service<GetCredential>("Stackit.MariaDB.GetCredential");
