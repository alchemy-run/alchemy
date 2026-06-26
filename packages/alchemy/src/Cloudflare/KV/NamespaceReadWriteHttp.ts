import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeHttpKVNamespaceBinding,
  type KVHttpToken,
} from "./NamespaceHttp.ts";
import { makeReadKVHttpClient } from "./NamespaceReadHttp.ts";
import {
  KVNamespaceReadWrite,
  type ReadWriteKVNamespaceClient,
} from "./NamespaceReadWrite.ts";
import { makeWriteKVHttpClient } from "./NamespaceWriteHttp.ts";

/**
 * HTTP-backed implementation of the {@link KVNamespaceReadWrite} service.
 *
 * It creates a scoped {@link AccountApiToken} with the `Workers KV Storage
 * Read` and `Workers KV Storage Write` permissions.
 */
export const ReadWriteNamespaceHttp = Layer.effect(
  KVNamespaceReadWrite,
  Effect.suspend(() =>
    makeHttpKVNamespaceBinding({
      permissionGroups: ["Workers KV Storage Read", "Workers KV Storage Write"],
      makeClient: makeReadWriteKVHttpClient,
    }),
  ),
);

/** Build the HTTP-backed read-write client over a bound token + namespace. */
export const makeReadWriteKVHttpClient = (
  token: KVHttpToken,
  namespaceId: Effect.Effect<string>,
): ReadWriteKVNamespaceClient =>
  ({
    ...makeReadKVHttpClient(token, namespaceId),
    ...makeWriteKVHttpClient(token, namespaceId),
  }) as ReadWriteKVNamespaceClient;
