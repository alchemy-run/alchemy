import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHttpKVNamespaceBinding, type HttpToken } from "./NamespaceHttp.ts";
import { makeReadKVHttpClient } from "./ReadNamespaceHttp.ts";
import {
  ReadWriteNamespace,
  type ReadWriteNamespaceClient,
} from "./ReadWriteNamespace.ts";
import { makeWriteKVHttpClient } from "./WriteNamespaceHttp.ts";

/**
 * HTTP-backed implementation of the {@link ReadWriteNamespace} binding.
 *
 * It creates a scoped {@link AccountApiToken} with the `Workers KV Storage
 * Read` and `Workers KV Storage Write` permissions.
 */
export const ReadWriteNamespaceHttp = Layer.effect(
  ReadWriteNamespace,
  Effect.suspend(() =>
    makeHttpKVNamespaceBinding({
      permissionGroups: ["Workers KV Storage Read", "Workers KV Storage Write"],
      makeClient: makeReadWriteKVHttpClient,
    }),
  ),
);

/** Build the HTTP-backed read-write client over a bound token + namespace. */
export const makeReadWriteKVHttpClient = (
  token: HttpToken,
  namespaceId: Effect.Effect<string>,
): ReadWriteNamespaceClient =>
  ({
    ...makeReadKVHttpClient(token, namespaceId),
    ...makeWriteKVHttpClient(token, namespaceId),
  }) as ReadWriteNamespaceClient;
