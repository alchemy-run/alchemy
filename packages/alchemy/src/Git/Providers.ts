import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { Repository, RepositoryProvider } from "./Repository.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Git") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Registers the Git resource providers ({@link Repository}). The Git host
 * itself is a Cloudflare Worker, so include `Cloudflare.providers()`
 * alongside this one.
 *
 * @example
 * ```typescript
 * export default Alchemy.Stack(
 *   "GitApp",
 *   {
 *     providers: Layer.mergeAll(Cloudflare.providers(), Git.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const host = yield* GitHost;
 *     const repo = yield* Git.Repository("app", {
 *       url: host.url.as<string>(),
 *       owner: "acme",
 *     });
 *     return { cloneUrl: repo.cloneUrl };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Repository])).pipe(
    Layer.provide(RepositoryProvider()),
    Layer.provide(FetchHttpClient.layer),
    Layer.orDie,
  );
