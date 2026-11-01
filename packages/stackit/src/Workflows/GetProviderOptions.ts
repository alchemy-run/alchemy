import type * as workflows from "@distilled.cloud/stackit/workflows";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetProviderOptionsRequest extends Omit<
  workflows.GetProviderOptionsRequest,
  "regionId"
> {}

/**
 * Runtime binding for STACKIT Workflows `getProviderOptions`: read which versions this region offers, for instance to warn before one expires.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and provide
 * {@link GetProviderOptionsHttp}. The instance's region is injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: no role. The spec turns authorization off for this operation (`x-stackit-authorization.disabled`), so any STACKIT identity may call it, and the created service account holds no grant from this binding.
 *
 * ### Reading the Versions
 * **Example:** List the versions from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Airflow = Stackit.Workflows.Instance("Airflow", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const airflow = yield* Airflow;
 *     const getProviderOptions = yield* Stackit.Workflows.GetProviderOptions(airflow);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { versions } = yield* getProviderOptions({});
 *         return yield* HttpServerResponse.json(versions.map((entry) => entry.version));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.GetProviderOptionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface GetProviderOptions extends Binding.Service<
  GetProviderOptions,
  "Stackit.Workflows.GetProviderOptions",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetProviderOptionsRequest,
    ) => Effect.Effect<workflows.ProviderOptions, workflows.GetProviderOptionsError, RuntimeContext>
  >
> {}

export const GetProviderOptions = Binding.Service<GetProviderOptions>(
  "Stackit.Workflows.GetProviderOptions",
);
