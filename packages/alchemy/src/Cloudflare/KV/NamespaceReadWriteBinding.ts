import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeKVNamespaceBinding,
  type makeKVNamespaceHelpers,
} from "./NamespaceBinding.ts";
import { makeReadKVClient } from "./NamespaceReadBinding.ts";
import {
  KVNamespaceReadWrite,
  type ReadWriteKVNamespaceClient,
} from "./NamespaceReadWrite.ts";
import { makeWriteKVClient } from "./NamespaceWriteBinding.ts";

/**
 * Implementation of the {@link KVNamespaceReadWrite} service that uses a
 * Worker binding.
 */
export const ReadWriteNamespaceBinding = Layer.effect(
  KVNamespaceReadWrite,
  Effect.suspend(() =>
    makeKVNamespaceBinding({ makeClient: makeReadWriteKVClient }),
  ),
);

/** Build the read-write binding client from its read and write halves. */
export const makeReadWriteKVClient = (
  helpers: ReturnType<typeof makeKVNamespaceHelpers>,
): ReadWriteKVNamespaceClient =>
  ({
    ...makeReadKVClient(helpers),
    ...makeWriteKVClient(helpers),
  }) as ReadWriteKVNamespaceClient;
