import type * as sca from "@distilled.cloud/stackit/sca";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Environment } from "./Environment.ts";

export interface ListEnvironmentRegistriesRequest extends Omit<
  sca.ListEnvironmentRegistriesRequest,
  "projectId" | "region" | "environmentId"
> {}

/**
 * Runtime binding for STACKIT Container Applications' `listEnvironmentRegistries`: list the registry logins in an environment, and what uses each. A password the API returns stays `Redacted`.
 *
 * Bind this operation to an {@link Environment} in a Function/Worker init phase and
 * provide {@link ListEnvironmentRegistriesHttp}. The environment's project, region and id are injected into each request. A host signs with a service account key
 * Alchemy creates for it.
 *
 * Access: a custom role holding `sca.environment.registry.list`, the permission the API's spec names.
 * STACKIT binds roles on projects at the narrowest, so the role reaches every environment in the project.
 *
 * ### Auditing Registries
 * **Example:** List who uses which registry login
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
 *     const listRegistries = yield* Stackit.ContainerApplications.ListEnvironmentRegistries(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { registries } = yield* listRegistries();
 *         return yield* HttpServerResponse.json(registries.map(({ server, status }) => ({ server, consumers: status?.consumers ?? [] })));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.ListEnvironmentRegistriesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Container Applications
 */
export interface ListEnvironmentRegistries extends Binding.Service<
  ListEnvironmentRegistries,
  "Stackit.ContainerApplications.ListEnvironmentRegistries",
  (
    environment: Environment,
  ) => Effect.Effect<
    (
      request?: ListEnvironmentRegistriesRequest,
    ) => Effect.Effect<
      sca.EnvironmentRegistriesVault,
      sca.ListEnvironmentRegistriesError,
      RuntimeContext
    >
  >
> {}

export const ListEnvironmentRegistries = Binding.Service<ListEnvironmentRegistries>(
  "Stackit.ContainerApplications.ListEnvironmentRegistries",
);
