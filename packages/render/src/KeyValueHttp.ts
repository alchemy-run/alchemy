import {
  makeRead,
  makeReadWrite,
  makeWrite,
  type ReadClient,
  type ReadWriteClient,
  type Url,
  type WriteClient,
} from "@alchemy.run/redis";

/**
 * Shared RESP/HTTP client builders for Render Key Value / Redis bindings.
 *
 * NOT exported from `index.ts`.
 */
export const makeReadKeyValueClient = (url: Url): ReadClient => makeRead(url);
export const makeWriteKeyValueClient = (url: Url): WriteClient => makeWrite(url);
export const makeReadWriteKeyValueClient = (url: Url): ReadWriteClient => makeReadWrite(url);
