import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KeyStore } from "./KeyStore.ts";
import { Platform } from "./Platform.ts";

/**
 * Keys kept on the model's own host, one object per subject: a Durable
 * Object on Cloudflare, an actor on Rivet, an entity on Effect Cluster, and
 * memory on `Domain.InMemory`. Each key lives in its object's own storage,
 * apart from every aggregate's.
 *
 * **Example:** Keys on Durable Objects
 * ```typescript
 * const Platform = DomainCloudflare.layerDurableObjects();
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.VaultLive),
 *   Layer.provide(Domain.HostKeyStore),
 *   Layer.provide(Domain.NoKeyWrap),
 *   Layer.provide(Platform),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyStore
 */
export const HostKeyStore: Layer.Layer<KeyStore, never, Platform> = Layer.effect(
  KeyStore,
  Effect.flatMap(Platform, (platform) => platform.keys),
);
