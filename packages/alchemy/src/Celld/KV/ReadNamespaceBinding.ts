import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeKVNamespaceBinding,
  type makeKVNamespaceHelpers,
} from "./NamespaceBinding.ts";
import type {
  NamespaceGetOptions,
  NamespaceListOptions,
  NamespaceValueType,
} from "./NamespaceTypes.ts";
import { ReadNamespace, type ReadNamespaceClient } from "./ReadNamespace.ts";

/**
 * Native Celld KV reads. The namespace is single-writer and has no read cache.
 *
 * @layer
 * @provides Celld.KV.ReadNamespace
 * @product KV
 */
export const ReadNamespaceBinding = Layer.effect(
  ReadNamespace,
  Effect.suspend(() =>
    makeKVNamespaceBinding({ makeClient: makeReadKVClient }),
  ),
);

/** Build the read half without retaining request I/O. */
export const makeReadKVClient = ({
  raw,
  use,
}: ReturnType<typeof makeKVNamespaceHelpers>): ReadNamespaceClient => ({
  raw,
  get: ((
    key: string | string[],
    options?:
      | NamespaceValueType
      | Partial<NamespaceGetOptions<NamespaceValueType>>,
  ) =>
    use((binding) => binding.get(key, options))) as ReadNamespaceClient["get"],
  getWithMetadata: ((
    key: string | string[],
    options?:
      | NamespaceValueType
      | Partial<NamespaceGetOptions<NamespaceValueType>>,
  ) =>
    use((binding) =>
      binding.getWithMetadata(key, options),
    )) as ReadNamespaceClient["getWithMetadata"],
  list: <Metadata = unknown>(options?: NamespaceListOptions) =>
    use((binding) => binding.list<Metadata>(options)),
});
