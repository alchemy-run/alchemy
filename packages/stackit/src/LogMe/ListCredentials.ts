import type * as logme from "@distilled.cloud/stackit/logme";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListCredentialsRequest extends Omit<
  logme.ListCredentialsRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT LogMe `listCredentials`: list the ids of the instance's
 * credentials.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListCredentialsHttp}. The instance's project, region and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with the single permission `logme.credential.list`, bound on
 * the project holding the instance. STACKIT binds roles on projects at the narrowest,
 * so the permission reaches every STACKIT LogMe instance in that project.
 *
 * ### Calling `listCredentials`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.LogMe.Instance("Logs", {
 *   version: "2",
 *   planName: "stackit-logme2-1.2.50-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const instance = yield* Logs;
 *     const listCredentials = yield* Stackit.LogMe.ListCredentials(instance);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { credentialsList } = yield* listCredentials({});
 *         return yield* HttpServerResponse.json({ count: credentialsList.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LogMe.ListCredentialsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogMe
 */
export interface ListCredentials extends Binding.Service<
  ListCredentials,
  "Stackit.LogMe.ListCredentials",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListCredentialsRequest,
    ) => Effect.Effect<logme.ListCredentialsResponse, logme.ListCredentialsError, RuntimeContext>
  >
> {}

export const ListCredentials = Binding.Service<ListCredentials>("Stackit.LogMe.ListCredentials");
