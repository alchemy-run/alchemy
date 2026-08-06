/**
 * The per-instance state and storage services for Celld-hosted Durable
 * Objects.
 *
 * A Celld fleet executes the same Worker bundle (and the same
 * `makeDurableObjectBridge` runtime) that Cloudflare Workers use, so the
 * state/storage services ARE the Cloudflare ones — re-exported here so
 * fleet code reads `Celld.DurableObjectState` without reaching into the
 * `Cloudflare` namespace.
 */
export {
  DurableObjectState,
  fromDurableObjectState,
} from "../Cloudflare/Workers/DurableObjectState.ts";
export type {
  DurableObjectStorage,
  DurableObjectTransaction,
  SqlCursor,
  SqlStorage,
} from "../Cloudflare/Workers/DurableObjectStorage.ts";
