import type * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListTokensRequest extends Omit<
  modelExperiments.ListInstanceTokensRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for `listInstanceTokens`: list an instance's tracking tokens. None of them
 * carries its value. Bind it to an {@link Instance} and provide {@link ListTokensHttp}. The
 * instance's project, region and id are injected into each request, and the host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `model-experiments.token.list`, on the project holding
 * the token. STACKIT binds roles on projects, folders and organizations, never on one token,
 * so the role reaches every token of the service in the project. The deployer needs
 * `iam.role.add` on the project to define it.
 *
 * ### Listing Tokens
 * **Example:** List the instance's tokens
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Experiments = Stackit.ModelExperiments.Instance("Experiments", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const binding = yield* Stackit.ModelExperiments.ListTokens(yield* Experiments);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { tokens } = yield* binding();
 *         return yield* HttpServerResponse.json(tokens.map((token) => token.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.ListTokensHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface ListTokens extends Binding.Service<
  ListTokens,
  "Stackit.ModelExperiments.ListTokens",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListTokensRequest,
    ) => Effect.Effect<
      modelExperiments.ListInstanceTokensResponse,
      modelExperiments.ListInstanceTokensError,
      RuntimeContext
    >
  >
> {}

export const ListTokens = Binding.Service<ListTokens>("Stackit.ModelExperiments.ListTokens");
