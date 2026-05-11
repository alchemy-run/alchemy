import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import { Instance, InstanceProvider } from "./Compute/Instance.ts";
import { fromEnv } from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Vultr",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all Vultr resource providers and the
 * resolved `Credentials` (read from the `VULTR_API_KEY` env var) plus a
 * fetch-based `HttpClient`.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Vultr from "alchemy/Vultr";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Vultr.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const vm = yield* Vultr.Instance("api", {
 *       region: "ewr",
 *       plan: "vc2-1c-1gb",
 *       osId: 1743,
 *     });
 *     return { ip: vm.mainIp };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Instance])).pipe(
    Layer.provide(InstanceProvider()),
    Layer.provideMerge(fromEnv()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
