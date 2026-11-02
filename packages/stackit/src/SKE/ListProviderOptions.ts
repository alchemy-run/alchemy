import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/**
 * Runtime binding for SKE `listProviderOptions`: the Kubernetes versions, OS
 * image versions, machine types, availability zones and volume types a region
 * offers, with the state and expiry of each version.
 *
 * The operation takes no project, so this binding has no bound resource and
 * grants no role; pass the region in each request. Provide {@link
 * ListProviderOptionsHttp}. A foreign host signs with a service account key
 * Alchemy creates for it.
 *

 * ### Reading What a Region Offers
 * **Example:** List the supported Kubernetes versions
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listOptions = yield* Stackit.SKE.ListProviderOptions();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const options = yield* listOptions({ region: "eu01", versionState: "SUPPORTED" });
 *         return yield* HttpServerResponse.json(options.kubernetesVersions ?? []);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.ListProviderOptionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface ListProviderOptions extends Binding.Service<
  ListProviderOptions,
  "Stackit.SKE.ListProviderOptions",
  () => Effect.Effect<
    (
      request: ske.ListProviderOptionsRequest,
    ) => Effect.Effect<ske.ProviderOptions, ske.ListProviderOptionsError, RuntimeContext>
  >
> {}

export const ListProviderOptions = Binding.Service<ListProviderOptions>(
  "Stackit.SKE.ListProviderOptions",
);
