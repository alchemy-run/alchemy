import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import * as Provider from "alchemy/Provider";
import * as Layer from "effect/Layer";
import { Backfill, BackfillProvider } from "./Backfill.ts";

/** Service tag bundling the providers of Domain models hosted on Cloudflare. */
export class Providers extends Provider.ProviderCollection<Providers>()("Domain.Cloudflare") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * The providers of Domain models hosted on Cloudflare Durable Objects: the
 * {@link Backfill} a deploy waits on while new views and projections receive
 * their history. Add it next to `Cloudflare.providers()` in any Stack that
 * deploys a Worker built with `DomainCloudflare.layerDurableObjects()`.
 * Without it, the deploy fails: no provider handles `Cloudflare.Domain.Backfill`.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import BankWorker from "./BankWorker.ts";
 *
 * export default Alchemy.Stack(
 *   "Bank",
 *   {
 *     providers: Layer.mergeAll(Cloudflare.providers(), DomainCloudflare.providers()),
 *     state: Cloudflare.state(),
 *   },
 *   Effect.gen(function* () {
 *     const worker = yield* BankWorker;
 *     return { url: worker.url };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Backfill])).pipe(
    Layer.provide(BackfillProvider()),
    Layer.provide(CloudflareApiLive()),
    Layer.orDie,
  );
