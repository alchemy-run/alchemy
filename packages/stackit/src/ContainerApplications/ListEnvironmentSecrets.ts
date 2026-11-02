import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Environment } from "./Environment.ts";

export interface ListEnvironmentSecretsRequest extends Omit<
  sca.ListEnvironmentSecretsRequest,
  "projectId" | "region" | "environmentId"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `listEnvironmentSecrets`: list the secrets in an environment, and what uses each. A value the API returns stays `Redacted`.
 *
 * Bind this operation to an {@link Environment} in a Function/Worker init phase and
 * provide {@link ListEnvironmentSecretsHttp}. The environment's project, region and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.environment.secret.list`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every environment in the project.
 *
 * ### Auditing Secrets
 * **Example:** List who uses which secret
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     const listSecrets = yield* Stackit.ContainerApplications.ListEnvironmentSecrets(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { secrets } = yield* listSecrets();
 *         return yield* HttpServerResponse.json(secrets.map(({ key, status }) => ({ key, consumers: status?.consumers ?? [] })));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.ListEnvironmentSecretsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface ListEnvironmentSecrets extends Binding.Service<
  ListEnvironmentSecrets,
  "Stackit.ContainerApplications.ListEnvironmentSecrets",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: ListEnvironmentSecretsRequest,
    ) => Effect.Effect<sca.EnvironmentSecretsVault, sca.ListEnvironmentSecretsError, RuntimeContext>
  >
> {}

export const ListEnvironmentSecrets = Binding.Service<ListEnvironmentSecrets>(
  "Stackit.ContainerApplications.ListEnvironmentSecrets",
);
