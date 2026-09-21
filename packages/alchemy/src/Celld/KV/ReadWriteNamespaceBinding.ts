import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeKVNamespaceBinding,
  type makeKVNamespaceHelpers,
} from "./NamespaceBinding.ts";
import { makeReadKVClient } from "./ReadNamespaceBinding.ts";
import {
  ReadWriteNamespace,
  type ReadWriteNamespaceClient,
} from "./ReadWriteNamespace.ts";
import { makeWriteKVClient } from "./WriteNamespaceBinding.ts";

/**
 * Native Celld KV reads and writes on the namespace's single writer.
 *
 * @layer
 * @provides Celld.KV.ReadWriteNamespace
 * @product KV
 */
export const ReadWriteNamespaceBinding = Layer.effect(
  ReadWriteNamespace,
  Effect.suspend(() =>
    makeKVNamespaceBinding({ makeClient: makeReadWriteKVClient }),
  ),
);

/** Build the read-write binding client from its read and write halves. */
export const makeReadWriteKVClient = (
  helpers: ReturnType<typeof makeKVNamespaceHelpers>,
): ReadWriteNamespaceClient =>
  ({
    ...makeReadKVClient(helpers),
    ...makeWriteKVClient(helpers),
  }) satisfies ReadWriteNamespaceClient;
