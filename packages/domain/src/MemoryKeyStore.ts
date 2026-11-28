import * as Layer from "effect/Layer";
import { KeyStore, memoryKeys } from "./KeyStore.ts";

/**
 * Keys kept in memory, for tests and local runs: they are gone when the
 * process ends, and with them everything sealed.
 *
 * @layer
 * @provides Domain.KeyStore
 */
export const MemoryKeyStore: Layer.Layer<KeyStore> = Layer.sync(KeyStore, () => memoryKeys());
